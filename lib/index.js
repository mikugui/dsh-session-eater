/**
 * dsh-session-eater — 宿主半边。
 *
 * 职责：
 *   1. 提供 `/dsh-session-eater/*` HTTP 路由：删除（喂鱼）、撤销（吐出来）、
 *      形象兜底图、自检状态；
 *   2. 真正执行「吃掉一个会话」：先把它从工作区账目与归档集合里摘掉，再把会话
 *      目录移进回收站（不硬删，可撤销），清掉投影缓存，最后向所有已连接的浏览器
 *      广播 `api-session/removed`，让左侧列表实时少掉那一行。
 *
 * 为什么自己实现删除：DSH 内核 0.1.5-rc.2 并没有可用的会话删除 RPC ——
 * `workspace/deleteSession` / `workspace/unarchiveSession` 只在 typert 清单里
 * 声明（见 @deepseek-ai/dsh-api-workspace-controller/lib/typert.host.js），
 * 宿主侧的 WorkspaceController 里并没有对应实现，调用只会失败。所以这里用
 * 内核已有的公开服务自己完成：ctx.workspaceRegistry（账目/归档）+
 * 文件系统（会话目录）+ ctx.emit("api-session/removed")（前端实时同步）。
 *
 * @module dsh-session-eater
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名（cordis loader 行 id 与客户端模块 id 都用它）。 */
export const name = 'dsh-session-eater'
/** 依赖宿主 webServer 服务来注册路由。 */
export const inject = ['webServer']
/**
 * 宿主半边版本；/status 会报出来，方便确认热重载到底有没有生效。
 *
 * 从 package.json 读，**不要写死** —— 之前写死成 '0.3.0'，结果包已经到 0.4.x 了
 * /status 还在报 0.3.0，排障时差点把"宿主是新的"误判成"宿主没重载"。
 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_FALLBACK_IMAGE = join(HERE, '..', 'assets', 'whale-fallback.png')
/** 本插件所有路由的公共前缀。 */
const BASE = '/dsh-session-eater'
/** 回收站目录名（挂在 $DSH_HOME 下，避开 sessions/ 所以不会被内核索引）。 */
const TRASH_DIR = 'session-eater-trash'
/** 回收站里记录原始位置的小清单，撤销时按它搬回去。 */
const MANIFEST = '.dsh-session-eater.json'
/** 会话 id 只允许这一种形状，杜绝路径穿越。 */
const SESSION_ID_RE = /^session-[A-Za-z0-9][A-Za-z0-9._-]*$/
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
}

/**
 * 解析 DSH home（与内核 `dshHomePath()` 同优先级：$DSH_HOME 优先，否则 ~/.dsh）。
 * @returns {string} 绝对的 DSH home 路径。
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * 读取请求体并解析 JSON，带大小上限。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @param {number} [limit] - 最大字节数。
 * @returns {Promise<Record<string, unknown>>} 解析后的 JSON 对象。
 */
function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error && error.message)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 写出一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 要序列化的值。
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': String(body.length) })
  res.end(body)
}

/**
 * 判断一个路径是否是已存在的目录。
 * @param {string} path - 待检查路径。
 * @returns {Promise<boolean>} 是目录则 true。
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 定位磁盘上的会话目录：`$DSH_HOME/sessions/<工作区分桶>/<sessionId>`。
 * 未落盘的空白会话命中空数组，这是正常的（它不是错误）。
 * @param {string} home - DSH home。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string[]>} 命中的会话目录。
 */
async function findSessionDirs(home, sessionId) {
  const root = join(home, 'sessions')
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const hits = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    if (await isDirectory(candidate)) hits.push(candidate)
  }
  return hits
}

/**
 * 把一个会话从工作区账目里摘出来（工作区本身保留）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string | undefined>} 摘除成功时返回所属工作区 id。
 */
async function detachFromWorkspace(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  for (const workspace of registry.list()) {
    if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue
    await workspace.detachSession(sessionId)
    return workspace.id
  }
  return undefined
}

/**
 * 把会话移出归档集合（幂等；指向已消失会话的陈旧归档项也一并清掉）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<boolean>} 归档集合确实发生了变化则 true。
 */
async function dropFromArchive(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return false
  const archived = registry.archivedSessionIds
  if (!Array.isArray(archived) || !archived.includes(sessionId)) return false
  await registry.unarchiveSession(sessionId)
  return true
}

/**
 * 会话是否正在跑（跑着的会话不允许喂鱼：宿主还握着它的写句柄）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {boolean} 正在运行则 true。
 */
function isRunning(ctx, sessionId) {
  try {
    return ctx.get('agents')?.get?.(sessionId)?.status === 'running'
  } catch {
    return false
  }
}

/**
 * 「吃掉」一个会话：摘账目 → 移入回收站 → 清投影缓存 → 广播移除。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<Record<string, unknown>>} 执行结果。
 */
async function eatSession(ctx, sessionId) {
  if (isRunning(ctx, sessionId)) {
    const error = new Error('该会话正在运行，先停止它再喂鱼')
    error.code = 'session-running'
    throw error
  }

  const home = dshHome()

  // 1. 先摘账目：即使磁盘操作失败，也不会留下指向已消失会话的工作区槽位。
  const workspaceId = await detachFromWorkspace(ctx, sessionId)
  const unarchived = await dropFromArchive(ctx, sessionId)

  // 2. 会话目录 → 回收站（move 而不是 rm，随时能吐出来）。
  //    注意：**移不动必须报错**。若这里静默成功，客户端会告诉用户"已吃掉"，
  //    而会话其实还在磁盘上、刷新就"复活" —— 那是最糟的失败模式。
  const dirs = await findSessionDirs(home, sessionId)
  const trashRoot = join(home, TRASH_DIR)
  const moved = []
  const failures = []
  if (dirs.length > 0) await mkdir(trashRoot, { recursive: true })
  for (const dir of dirs) {
    const bucket = join(trashRoot, `${Date.now()}-${sessionId}`)
    try {
      await rename(dir, bucket)
      await writeFile(
        join(bucket, MANIFEST),
        JSON.stringify({ sessionId, originalPath: dir, eatenAt: new Date().toISOString() }, null, 2),
        'utf8'
      )
      moved.push(bucket)
    } catch (error) {
      const message = String((error && error.message) || error)
      failures.push({ dir, error: message })
      ctx.logger.warn(`session-eater: 无法移动 ${dir} → ${bucket}: ${message}`)
    }
  }
  if (failures.length > 0) {
    const error = new Error(`会话目录移不动（多半被内核占用）: ${failures.map((f) => f.error).join('; ')}`)
    error.code = 'move-failed'
    throw error
  }

  // 3. 清掉投影缓存，避免重启后从缓存里复活一行。
  const projCache = join(home, 'storages', 'session_projcache', 'sessions')
  for (const name of [`${sessionId}.json`, `${sessionId}.json.tmp`]) {
    const cached = join(projCache, name)
    if (existsSync(cached)) await rm(cached, { force: true }).catch(() => {})
  }

  // 4. 广播给所有浏览器（api-session/removed 在 dsh-api-remotes 的转发白名单里，
  //    客户端会据此把这一行从会话列表里摘掉，无需刷新）。
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger.warn(`session-eater: 广播 api-session/removed 失败: ${String(error && error.message)}`)
  }

  ctx.logger.info(
    `session-eater: 吃掉 ${sessionId}` +
    `${workspaceId === undefined ? '' : `（工作区 ${workspaceId}）`}` +
    `${moved.length === 0 ? '（磁盘上无会话目录，仅摘账目）' : `（已移入回收站 ${moved.length} 份）`}`
  )

  return { sessionId, moved, ...(workspaceId === undefined ? {} : { workspaceId }), unarchived }
}

/**
 * 撤销一次喂鱼：按回收站里的清单把会话目录搬回原位。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<Record<string, unknown>>} 恢复结果。
 */
async function restoreSession(ctx, sessionId) {
  const home = dshHome()
  const trashRoot = join(home, TRASH_DIR)
  let entries = []
  try {
    entries = await readdir(trashRoot, { withFileTypes: true })
  } catch {
    return { sessionId, restored: [] }
  }
  const restored = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(sessionId)) continue
    const bucket = join(trashRoot, entry.name)
    let originalPath = join(home, 'sessions', '--restored--', sessionId)
    try {
      const manifest = JSON.parse(await readFile(join(bucket, MANIFEST), 'utf8'))
      if (typeof manifest.originalPath === 'string' && manifest.originalPath !== '') originalPath = manifest.originalPath
    } catch {
      /* 没有清单（旧版本或手写）时退回一个安全的默认落点 */
    }
    try {
      await mkdir(dirname(originalPath), { recursive: true })
      await rm(originalPath, { recursive: true, force: true })
      await rm(join(bucket, MANIFEST), { force: true })
      await rename(bucket, originalPath)
      restored.push(originalPath)
    } catch (error) {
      ctx.logger.warn(`session-eater: 恢复失败 ${entry.name}: ${String(error && error.message)}`)
    }
  }
  if (restored.length > 0) {
    ctx.logger.info(`session-eater: 吐出 ${sessionId} → ${restored.join(', ')}（刷新页面后回到列表）`)
  }
  return { sessionId, restored }
}

/**
 * 注册路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/delete`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const sessionId = String(body.sessionId || '')
        if (!SESSION_ID_RE.test(sessionId)) {
          sendJson(res, 400, { ok: false, error: `invalid sessionId: ${JSON.stringify(sessionId)}` })
          return
        }
        sendJson(res, 200, { ok: true, ...(await eatSession(ctx, sessionId)) })
      } catch (error) {
        const code = (error && error.code) || 'eat-failed'
        sendJson(res, code === 'session-running' ? 409 : 500, {
          ok: false,
          code,
          error: String((error && error.message) || error)
        })
      }
    }
  }), 'session-eater: /delete')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/restore`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const sessionId = String(body.sessionId || '')
        if (!SESSION_ID_RE.test(sessionId)) {
          sendJson(res, 400, { ok: false, error: `invalid sessionId: ${JSON.stringify(sessionId)}` })
          return
        }
        sendJson(res, 200, { ok: true, ...(await restoreSession(ctx, sessionId)) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'session-eater: /restore')

  // 形象兜底：余额挂件不在场（或换了目录名）时，用包里自带的那张小鲸鱼。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/whale.png`,
    handler: async (req, res) => {
      try {
        const bytes = await readFile(ASSET_FALLBACK_IMAGE)
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': String(bytes.length)
        })
        res.end(bytes)
      } catch (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`fallback image unavailable: ${String((error && error.message) || error)}`)
      }
    }
  }), 'session-eater: /whale.png')

  /** 自检路由：确认插件活着、形象素材在不在、DSH home 解析成什么。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/status`,
    handler: (req, res) => {
      try {
        const home = dshHome()
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          version: VERSION,
          home,
          sessionsRoot: join(home, 'sessions'),
          trashRoot: join(home, TRASH_DIR),
          fallbackImage: existsSync(ASSET_FALLBACK_IMAGE)
        })
      } catch (error) {
        sendJson(res, 200, { ok: false, where: 'status', error: String((error && error.stack) || error) })
      }
    }
  }), 'session-eater: /status')

  /** 最小连通性探针（排查路由冲突用）。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/ping`,
    handler: (req, res) => {
      sendJson(res, 200, { ok: true, pong: Date.now() })
    }
  }), 'session-eater: /ping')
}
