/**
 * 改仓库页面上那句「简介」（About 里的 Description，以及 homepage / topics）。
 *
 * 为什么单独一个脚本：简介只存在于 GitHub 服务器上，**不在仓库文件里** ——
 * 之前每次改都是临时敲一条 PATCH，既没留档也说不清"现在是哪句"。现在这句正文
 * 就写在下面的 ABOUT 里，改文案 = 改这个文件，跑一次即生效（幂等）。
 *
 * 用法：
 *   node scripts/update-meta.mjs                 # 显示现有 vs 新文案，然后写入
 *   node scripts/update-meta.mjs --dry-run       # 只看差异，不写入（不需要令牌）
 *   node scripts/update-meta.mjs --topics a,b    # 覆写 topics（默认用下面的 TOPICS）
 *
 * 凭据：环境变量 GITHUB_TOKEN / GITHUB_OWNER，或 <工作区根>/.github-token（同其它脚本）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const WORKSPACE_ROOT = join(PACKAGE_ROOT, '..')
const API = 'https://api.github.com'

/** 仓库页右侧那句简介。精简版：一句说清"是什么"，再点三个最想要的功能。 */
const ABOUT =
  '把不要的会话拖到侧栏底部的小胖鱼嘴边，它张嘴吃掉（移入回收站，可撤销）。'
  + '删除前确认、点图标直达设置、17 段界面文案可自定义 —— DSH Web 插件'

const HOMEPAGE = '' // 留空 = 清掉仓库的 Website 字段（我们只有 README）
const TOPICS = ['dsh', 'dsh-plugin', 'deepseek-harness', 'session', 'cleanup']

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const value = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const REPO = value('--repo', pkg.name)
const TOPICS_WANTED = value('--topics', '') === '' ? TOPICS : value('--topics', '').split(',').map((t) => t.trim()).filter(Boolean)

const TOKEN_PATTERN = /(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{36}|[0-9a-f]{40})/

/** 读凭据（与 publish / release 同一套规则）。 */
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
  if (token === '') throw new Error('凭据是空的（见 .github-token）。')
  return { token, owner }
}

/** JSON API 调用。 */
async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-session-eater-meta',
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  const json = text === '' ? null : (() => { try { return JSON.parse(text) } catch { return text } })()
  if (!res.ok) {
    const error = new Error(`${method} ${path} → ${res.status} ${json?.message ?? json}`)
    error.status = res.status
    throw error
  }
  return json
}

console.log(`简介（新）: ${ABOUT}`)
console.log(`长度      : ${ABOUT.length} 字符`)
console.log(`topics    : ${TOPICS_WANTED.join(', ')}`)
console.log(`仓库      : ${REPO}`)
if (DRY) {
  console.log('\n--dry-run：不校验凭据、不写入。')
  process.exit(0)
}

const { token, owner: configuredOwner } = credentials()
const user = await api(token, 'GET', '/user')
const owner = configuredOwner || user.login

const before = await api(token, 'GET', `/repos/${owner}/${REPO}`)
console.log(`\n简介（旧）: ${before.description ?? '(空)'}`)

const after = await api(token, 'PATCH', `/repos/${owner}/${REPO}`, {
  description: ABOUT,
  homepage: HOMEPAGE,
  topics: TOPICS_WANTED
})
console.log(`简介（现）: ${after.description ?? '(空)'}`)
console.log(`topics    : ${(after.topics ?? []).join(', ')}`)
console.log('\n✅ 已更新')
