/**
 * 会话存储现场取证（只读）。
 *
 * 排查「删了又回来 / 列表少了/多了会话」这类问题时用它，一条命令看清：
 *   · sessions/ 下现在有哪些会话、各自有多少条用户消息（= 是不是空白会话）
 *   · 回收站里躺着什么、原始路径是什么（manifest）
 *   · 投影缓存、工作区账目（sessionIds / archivedSessionIds）
 *
 * 注意一个格式细节：`session.v3.jsonl.zstd` 是**多帧** zstd 追加格式
 * （本机当前会话有 900+ 帧），而 Node 的 zstdDecompressSync /
 * createZstdDecompress 只给出**第一帧** —— 所以这里按 zstd 魔数切帧逐帧解压。
 *
 * 运行：node tests/inspect-sessions.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')

/** 按 zstd 魔数切帧逐帧解压；撞上魔数而解不动的片段会与下一段合并重试。 */
function decompressFrames(raw) {
  const offsets = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offsets.push(i)
  }
  const chunks = []
  let start = 0
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length
    if (end <= start) continue
    try {
      chunks.push(zstdDecompressSync(raw.subarray(start, end)).toString('utf8'))
      start = end
    } catch { /* 这段里恰好有魔数字节，留到下一轮 */ }
  }
  if (start < raw.length) {
    try { chunks.push(zstdDecompressSync(raw.subarray(start)).toString('utf8')) } catch { /* 尾部残缺，忽略 */ }
  }
  return chunks.join('')
}

/** 观察一个会话目录：字节数、事件数、用户消息数、是否空白。 */
function inspectSession(dir) {
  const name = readdirSync(dir).find((n) => n.startsWith('session.v3.jsonl'))
  if (name === undefined) return { files: readdirSync(dir).length, note: 'no session log' }
  const raw = readFileSync(join(dir, name))
  const text = name.endsWith('.zstd') ? decompressFrames(raw) : raw.toString('utf8')
  const events = text.split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const user = events.filter((e) => e.type === 'user/message')
  const firstText = (() => {
    const blocks = user[0]?.data?.content ?? user[0]?.data?.message?.content
    if (!Array.isArray(blocks)) return null
    return blocks.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join(' ').trim().slice(0, 50) || null
  })()
  return {
    bytes: raw.length,
    events: events.length,
    userMessages: user.length,
    blank: user.length === 0,
    firstUser: firstText
  }
}

const sessionsRoot = join(HOME, 'sessions')
console.log(`DSH_HOME = ${HOME}`)
console.log(`now      = ${new Date().toLocaleString()}`)

console.log('\n=== sessions/ （当前会被列出来的）===')
if (existsSync(sessionsRoot)) {
  for (const bucket of readdirSync(sessionsRoot)) {
    const bucketPath = join(sessionsRoot, bucket)
    if (!statSync(bucketPath).isDirectory()) continue
    for (const name of readdirSync(bucketPath)) {
      const dir = join(bucketPath, name)
      if (!statSync(dir).isDirectory()) continue
      console.log(`- ${name}`)
      console.log(`    mtime=${new Date(statSync(dir).mtimeMs).toLocaleString()}  ` +
        `${JSON.stringify(inspectSession(dir))}`)
    }
  }
} else console.log('(missing)')

console.log('\n=== session-eater-trash/ （被吃掉的）===')
const trashRoot = join(HOME, 'session-eater-trash')
if (existsSync(trashRoot)) {
  for (const name of readdirSync(trashRoot)) {
    const dir = join(trashRoot, name)
    const movedAt = Number(name.split('-')[0])
    console.log(`- ${name}`)
    console.log(`    moved=${Number.isFinite(movedAt) ? new Date(movedAt).toLocaleString() : '?'}  ` +
      `${JSON.stringify(inspectSession(dir))}`)
    const manifest = join(dir, '.dsh-session-eater.json')
    if (existsSync(manifest)) console.log(`    manifest: ${readFileSync(manifest, 'utf8').replace(/\s+/g, ' ')}`)
  }
} else console.log('(none)')

console.log('\n=== storages/session_projcache/sessions ===')
const cache = join(HOME, 'storages', 'session_projcache', 'sessions')
if (existsSync(cache)) for (const name of readdirSync(cache)) console.log(`- ${name}`)
else console.log('(none)')

console.log('\n=== storages/workspace.json ===')
const workspace = join(HOME, 'storages', 'workspace.json')
if (existsSync(workspace)) console.log(readFileSync(workspace, 'utf8').replace(/\s+/g, ' '))
else console.log('(none)')
