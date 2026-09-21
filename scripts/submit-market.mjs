/**
 * 把本插件投稿到 DSH 统一市场的精选目录（awesome-dsh-plugin）。
 *
 * 一次跑完这几件事（全程 REST API，不需要 git）：
 *   1. 前置检查：仓库创建满 1 天（CI 第 3 项硬性检查，不满就别浪费一次 PR）
 *   2. 给仓库加 `dsh-plugin` topic（GitHub 生态那一源按它搜）
 *   3. 给最新 Release 补一个**不带版本号**的 `dsh-session-eater.tgz` 附件
 *      （这样 market-entry.yml 里的 `releases/latest/download/...` 链接不会因发新版而 404）
 *   4. fork awesome-dsh-plugin/awesome-dsh-plugin → 建分支 → 写
 *      `data/plugins/mikugui__dsh-session-eater.yml` → 开 PR
 *
 * 用法：
 *   node scripts/submit-market.mjs --dry-run     # 离线：只打印计划与 entry 内容
 *   node scripts/submit-market.mjs               # 真提交（需要令牌）
 *   node scripts/submit-market.mjs --prepare     # 先做能做的：topic + tarball + fork + 分支 + 文件；
 *                                                #   跳过 1 天门槛、不建 PR（到点后再跑一次即可）
 *   node scripts/submit-market.mjs --force       # 忽略 1 天门槛（会大概率被 CI 拒）
 *   node scripts/submit-market.mjs --skip-fork   # 已手动 fork 过，跳过 fork 等待
 *
 * 凭据：环境变量 GITHUB_TOKEN / GITHUB_OWNER，或 <工作区根>/.github-token
 *      （第 1 行 token，第 2 行用户名；`#` 开头是注释；脚本会从整行里正则抠出令牌本体）
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const WORKSPACE_ROOT = join(PACKAGE_ROOT, '..')
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'

/** 精选目录所在仓库。 */
const TARGET = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' }

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}
const DRY = flag('--dry-run')
const FORCE = flag('--force')
/** --prepare：先把不受 1 天门槛限制的步骤做掉（topic / tarball / fork / 分支 / 文件），不建 PR。 */
const PREPARE = flag('--prepare')
/**
 * 投稿的分支名。**改条目内容时建议换个新分支名**（`--branch update-entry-0.5.0` 之类）：
 * 分支已存在时脚本会沿用旧分支，而旧分支是基于当时那次 main 建的 —— 换成新分支才会
 * 基于**当前** main 建，PR 就是一次干净的增量，不会把上游这期间的改动一起卷进 diff。
 */
const BRANCH = value('--branch', 'add-dsh-session-eater')

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const SELF = { owner: 'mikugui', repo: pkg.name }
const ENTRY_PATH = 'data/plugins/mikugui__dsh-session-eater.yml'
const ENTRY_TEXT = readFileSync(join(HERE, 'market-entry.yml'), 'utf8')

const TOKEN_PATTERN = /(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{36}|[0-9a-f]{40})/

/** 读凭据（同 publish/release 两个脚本）。 */
function credentials() {
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  let owner = process.env.GITHUB_OWNER || ''
  if (token === '') {
    const file = join(WORKSPACE_ROOT, '.github-token')
    if (!existsSync(file)) throw new Error(`没有令牌：把 token 写到 ${file}，或设 GITHUB_TOKEN。`)
    const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
      .map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
    token = lines[0] ?? ''
    owner = owner || (lines[1] ?? '')
  }
  const match = TOKEN_PATTERN.exec(token)
  if (match !== null) token = match[0]
  if (!/^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{36}|[0-9a-f]{40})$/.test(token)) {
    throw new Error(`令牌形状可疑（长度 ${token.length}）：classic 应为 ghp_ + 36 字符。`)
  }
  return { token, owner }
}

/** JSON API 调用。 */
async function api(token, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-session-eater-submit',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  const json = text === '' ? null : (() => { try { return JSON.parse(text) } catch { return text } })()
  if (!res.ok) {
    const error = new Error(`${method} ${path} → ${res.status} ${json?.message ?? json}`)
    error.status = res.status
    error.detail = json
    throw error
  }
  return json
}

/** 上传附件（裸字节，走 uploads.github.com）。 */
async function uploadAsset(token, owner, repo, releaseId, file, name) {
  const bytes = readFileSync(file)
  const res = await fetch(
    `${UPLOADS}/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'user-agent': 'dsh-session-eater-submit'
      },
      body: bytes
    }
  )
  const text = await res.text()
  const json = text === '' ? null : (() => { try { return JSON.parse(text) } catch { return text } })()
  if (!res.ok) throw new Error(`上传 ${name} → ${res.status} ${json?.message ?? json}`)
  return json
}

// ── 计划 ────────────────────────────────────────────────────────────────
console.log('投稿计划 ─────────────────────────────────────────────')
console.log(`  本仓库      : ${SELF.owner}/${SELF.repo}（版本 ${pkg.version}）`)
console.log(`  目标仓库    : ${TARGET.owner}/${TARGET.repo}`)
console.log(`  新增文件    : ${ENTRY_PATH}`)
console.log(`  分支        : ${BRANCH}`)
console.log(`  1) 加 topic : dsh-plugin, dsh, deepseek-harness`)
console.log(`  2) 补附件   : dsh-session-eater.tgz（不带版本号 → latest/download 不过期）`)
console.log(`  3) fork + 建分支 + 写文件 + 开 PR`)
console.log('\nentry 内容 ───────────────────────────────────────────')
console.log(ENTRY_TEXT.trimEnd())

if (DRY) {
  console.log('\n--dry-run：只打印计划，不校验凭据、不发任何请求。')
  process.exit(0)
}

const { token } = credentials()
const user = await api(token, 'GET', '/user')
const owner = user.login
console.log(`\n身份        : ${owner}`)

// ── 0) 仓库年龄门槛（CI 第 3 项，不满就别提）────────────────────────────
//    注意：门槛只在 CI 跑 PR 时才检查，所以 --prepare 可以直接跳过，
//    把 topic / tarball / fork / 分支 / 文件这些不受影响的事先做掉。
const selfRepo = await api(token, 'GET', `/repos/${owner}/${SELF.repo}`)
const createdUtc = new Date(selfRepo.created_at)
const ageHours = (Date.now() - createdUtc.getTime()) / 36e5
const eligible = new Date(createdUtc.getTime() + 864e5)
const eligibleLocal = new Date(eligible.getTime() + 8 * 36e5).toISOString().replace('T', ' ').slice(0, 19)
console.log(`仓库年龄    : ${ageHours.toFixed(1)} 小时（门槛 24 小时）`)
if (ageHours < 24 && !FORCE) {
  const left = (24 - ageHours).toFixed(1)
  if (!PREPARE) {
    throw new Error(
      `还差 ${left} 小时才满 1 天 —— CI 会拒绝（repo age 是硬性检查）。\n` +
      `  可提时间（UTC）    : ${eligible.toISOString()}\n` +
      `  可提时间（北京时间）: ${eligibleLocal}\n` +
      '  想先做能做的部分：加 --prepare（跳过门槛，只做 topic/tarball/fork/分支/文件），到点再跑一次。'
    )
  }
  console.log(`  --prepare 模式：跳过门槛，先做不受影响的步骤；开 PR 需等到 ${eligibleLocal}（还差 ${left} 小时）`)
}

// ── 1) topics ──────────────────────────────────────────────────────────
const wanted = ['dsh-plugin', 'dsh', 'deepseek-harness']
const topics = [...new Set([...(selfRepo.topics ?? []), ...wanted])]
await api(token, 'PUT', `/repos/${owner}/${SELF.repo}/topics`, { names: topics })
console.log(`已设 topics : ${topics.join(', ')}`)

// ── 2) 无版本号的 tarball 附件 ─────────────────────────────────────────
const localTgz = join(WORKSPACE_ROOT, `${pkg.name}-${pkg.version}.tgz`)
if (!existsSync(localTgz)) throw new Error(`找不到本地 tgz：${localTgz}（先跑 npm pack --pack-destination ..）`)
const tag = `v${pkg.version}`
const release = await api(token, 'GET', `/repos/${owner}/${SELF.repo}/releases/tags/${tag}`)
const stableName = `${pkg.name}.tgz`
if ((release.assets ?? []).some((asset) => asset.name === stableName)) {
  console.log(`附件已存在  : ${stableName}`)
} else {
  const asset = await uploadAsset(token, owner, SELF.repo, release.id, localTgz, stableName)
  console.log(`已上传附件  : ${asset.name}  ${(asset.size / 1024).toFixed(1)} KB`)
}

// ── 3) fork → 分支 → 文件 → PR ─────────────────────────────────────────
const forkFull = `${owner}/${TARGET.repo}`
if (!flag('--skip-fork')) {
  try {
    await api(token, 'POST', `/repos/${TARGET.owner}/${TARGET.repo}/forks`, { default_branch_only: true })
    console.log(`已发起 fork : ${forkFull}（等待就绪…）`)
  } catch (error) {
    if (error.status === 422) console.log(`fork 已存在 : ${forkFull}`)
    else if (error.status === 403) {
      throw new Error(`这个令牌不能 fork（403）。请在网页上点一次 Fork：` +
        `https://github.com/${TARGET.owner}/${TARGET.repo}/fork 然后加 --skip-fork 重跑。`)
    } else throw error
  }
  for (let i = 0; i < 30; i += 1) {
    try {
      const info = await api(token, 'GET', `/repos/${forkFull}`)
      if (info.size > 0 || info.default_branch !== undefined) break
    } catch { /* 还没建好 */ }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

const base = await api(token, 'GET', `/repos/${TARGET.owner}/${TARGET.repo}/git/ref/heads/main`)
const baseSha = base.object.sha
console.log(`目标 main   : ${baseSha.slice(0, 8)}`)

try {
  await api(token, 'POST', `/repos/${forkFull}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: baseSha })
  console.log(`已建分支    : ${BRANCH}`)
} catch (error) {
  if (error.status !== 422) throw error
  console.log(`分支已存在  : ${BRANCH}（将覆盖提交）`)
}

// 文件已存在时要用它的 sha 才能更新
let existingSha
try {
  const existing = await api(token, 'GET', `/repos/${forkFull}/contents/${ENTRY_PATH}?ref=${BRANCH}`)
  existingSha = existing.sha
} catch { /* 新文件 */ }

await api(token, 'PUT', `/repos/${forkFull}/contents/${ENTRY_PATH}`, {
  message: `Add ${SELF.owner}/${SELF.repo}`,
  content: Buffer.from(ENTRY_TEXT, 'utf8').toString('base64'),
  branch: BRANCH,
  ...(existingSha === undefined ? {} : { sha: existingSha })
})
console.log(`已写文件    : ${ENTRY_PATH}`)

if (PREPARE) {
  console.log('\n--prepare 完成：topic / tarball / fork / 分支 / 文件 都就位了。')
  console.log(`  分支 ${owner}:${BRANCH} 已在你的 fork 里，随时可以开 PR。`)
  console.log(`  到 ${eligibleLocal}（北京时间）之后，二选一：`)
  console.log('    · 再跑一次本脚本（去掉 --prepare）→ 自动开 PR')
  console.log(`    · 或打开 https://github.com/${forkFull}/tree/${BRANCH} 点 "Compare & pull request"`)
  process.exit(0)
}

const pr = await api(token, 'POST', `/repos/${TARGET.owner}/${TARGET.repo}/pulls`, {
  title: `Add ${SELF.owner}/${SELF.repo}`,
  head: `${owner}:${BRANCH}`,
  base: 'main',
  body: [
    `Adds \`${ENTRY_PATH}\`.`,
    '',
    `**${pkg.name}** — 会话清理（喂鱼）：把 DSH 侧边栏里不要的会话拖到余额挂件的小胖鱼身上，`,
    '它张嘴吃掉（会话目录移入回收站，可撤销）。宿主半边只用 Node 内置模块，客户端半边只 require',
    '宿主已提供的 react，**零运行时依赖、无构建步骤**。',
    '',
    `- \`dsh.bundle\`：\`./cordis.patch.yml\`（同时声明 \`dsh.client\`，带浏览器 UI）`,
    '- 撤销三条路径：药丸行右侧按钮 / 常驻回执 / 设置页「最近吃掉」台账',
    '- 自动化验证：宿主契约 9 项 + 浏览器端到端 25 项 + 设置页 21 项',
    `- Release：https://github.com/${SELF.owner}/${SELF.repo}/releases/tag/${tag}`
  ].join('\n')
})
console.log(`\n✅ PR 已创建 : ${pr.html_url}`)
console.log('   合并后站点与市场会自动重建，通常一天内生效。')
