/**
 * 把本仓库作为一个 commit 推到 GitHub —— 全程走 REST API（Git Data API），
 * **不需要安装 git**。
 *
 * 凭据读取顺序（前者优先）：
 *   1) 环境变量 GITHUB_TOKEN / GH_TOKEN（+ GITHUB_OWNER）
 *   2) 文件 <工作区根>/.github-token —— 第一行 token，第二行 GitHub 用户名
 *
 * 用法：
 *   node scripts/publish-github.mjs                 # 默认仓库名 dsh-session-eater，公开
 *   node scripts/publish-github.mjs --private
 *   node scripts/publish-github.mjs --repo other-name
 *   node scripts/publish-github.mjs --dry-run       # 只列出要上传哪些文件
 *
 * 说明：仓库已存在时会基于现有分支追加一个 commit；不存在则创建（公开/私有按参数）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const WORKSPACE_ROOT = join(PACKAGE_ROOT, '..')
const API = 'https://api.github.com'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

const REPO = value('--repo', 'dsh-session-eater')
const PRIVATE = flag('--private')
const DRY = flag('--dry-run')
const SKIP_DIRS = new Set(['node_modules', '.git', '_probe', 'test-results'])

/**
 * 已知的 GitHub 令牌形状。用它从一整行文本里**抠出**令牌本体 ——
 * 用户很容易只替换模板行的后半段，留下 `ghp_` 或 `github_` 之类的前缀，
 * 或者顺手把引号/空格一起复制进来。所以不要求整行干净，能认出来就行。
 */
const TOKEN_PATTERN = /(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{36}|[0-9a-f]{40})/

/**
 * 从一行里提取令牌。
 * @param {string} line - 凭据文件里的某一行（允许带前后缀、引号、空格）。
 * @returns {string} 令牌本体，认不出来时返回清理后的原串。
 */
function extractToken(line) {
  const cleaned = line.trim().replace(/^["'`]|["'`]$/g, '')
  const match = TOKEN_PATTERN.exec(cleaned)
  return match === null ? cleaned : match[0]
}

/**
 * 令牌形状预检 —— 不合法就别去撞 401，直接把「应该长什么样」说清楚。
 * 已知形状（GitHub）：
 *   ghp_ + 36   = classic PAT（40 字符）
 *   github_pat_ + 82 左右 = fine-grained PAT（93 字符上下）
 *   gho_/ghu_/ghs_/ghr_ + 36 = OAuth / user / server / refresh token
 * @param {string} token - 待检查的令牌。
 */
function assertTokenShape(token) {
  const shapes = [
    [/^ghp_[A-Za-z0-9]{36}$/, 'classic PAT（ghp_ + 36 字符 = 40 字符）'],
    [/^github_pat_[A-Za-z0-9_]{20,}$/, 'fine-grained PAT（github_pat_ 开头）'],
    [/^gh[ousr]_[A-Za-z0-9]{36}$/, 'GitHub App / OAuth token'],
    [/^[0-9a-f]{40}$/, '旧式 40 位十六进制 OAuth token']
  ]
  if (shapes.some(([re]) => re.test(token))) return
  const hint = token.startsWith('ghp_')
    ? 'classic token 应当是 ghp_ 加 36 个字符、共 40 字符 —— 你这个长度不对，多半是把别的内容一起复制进来了（或者被截断）。去 https://github.com/settings/tokens 点 token 右边的复制图标重取一次。'
    : token.startsWith('github_pat_')
      ? 'fine-grained token 通常 93 字符左右，你这个长度对不上，重取一次试试。'
      : '既不是 ghp_ 也不是 github_pat_ 开头 —— 看起来不像 GitHub 令牌。'
  throw new Error(`令牌形状可疑：长度 ${token.length}，前缀 "${token.slice(0, 11)}…"。${hint}`)
}

/** 读凭据。 */
function credentials() {
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  let owner = process.env.GITHUB_OWNER || ''
  if (token === '') {
    const file = join(WORKSPACE_ROOT, '.github-token')
    if (existsSync(file)) {
      // 允许 `#` 开头的注释行，方便把填写说明直接写在凭据文件里；
      // 顺带剥掉 UTF-8 BOM（记事本存出来的文件会带）
      const lines = readFileSync(file, 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
      token = lines[0] ?? ''
      owner = owner || (lines[1] ?? '')
      if (/REPLACE_ME|PASTE|YOUR_TOKEN/i.test(token)) {
        throw new Error(`凭据文件里的 token 还是占位符 —— 把 ${file} 里那行占位符换成真 token 再试。`)
      }
    }
  }
  if (token === '') {
    throw new Error(
      '没有找到 GitHub 令牌。把 token 写到 ' + join(WORKSPACE_ROOT, '.github-token') +
      '（第一行 token，第二行用户名），或设环境变量 GITHUB_TOKEN / GITHUB_OWNER。'
    )
  }
  // 从整行里抠出令牌本体：用户常常只替换模板行的后半段，
  // 留下 ghp_ / github_ 之类的前缀（这两种都真踩过）。
  token = extractToken(token)
  return { token, owner }
}

/** 统一的 API 调用，失败时把 GitHub 的报错原文抛出来。 */
async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-session-eater-publish',
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  const json = text === '' ? null : (() => { try { return JSON.parse(text) } catch { return text } })()
  if (!res.ok) {
    const message = json !== null && typeof json === 'object' ? json.message : String(json)
    const error = new Error(`${method} ${path} → ${res.status} ${message}`)
    error.status = res.status
    error.detail = json
    throw error
  }
  return json
}

/** 递归收集要上传的文件（相对路径 → 绝对路径）。 */
function collect(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    if (name.endsWith('.tgz') || name === '.github-token') continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) collect(full, base, out)
    else if (stat.isFile()) out.push({ path: relative(base, full).replace(/\\/g, '/'), full, size: stat.size })
  }
  return out
}

const { token, owner: configuredOwner } = credentials()
assertTokenShape(token)
const files = collect(PACKAGE_ROOT).sort((a, b) => a.path.localeCompare(b.path))
const totalBytes = files.reduce((sum, file) => sum + file.size, 0)

console.log(`仓库      : ${REPO}（${PRIVATE ? '私有' : '公开'}）`)
console.log(`待上传    : ${files.length} 个文件, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
for (const file of files) console.log(`  ${file.path}  ${(file.size / 1024).toFixed(1)} KB`)
if (DRY) {
  console.log('\n--dry-run：不实际推送。')
  process.exit(0)
}

const user = await api(token, 'GET', '/user')
const owner = configuredOwner || user.login
console.log(`\n身份      : ${user.login}（将推到 ${owner}/${REPO}）`)

// 1) 仓库：存在就复用，不存在就创建
let repo
try {
  repo = await api(token, 'GET', `/repos/${owner}/${REPO}`)
  console.log(`仓库已存在 : ${repo.html_url}（默认分支 ${repo.default_branch}）`)
} catch (error) {
  if (error.status !== 404) throw error
  repo = await api(token, 'POST', '/user/repos', {
    name: REPO,
    private: PRIVATE,
    description: '会话清理（喂鱼）：把不要的会话拖到余额挂件的小胖鱼身上「吃掉」（移入回收站，可撤销）——DSH Web 插件',
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    // 关键：让 GitHub 先生成一个初始提交。空仓库上 Git Data API 会 409
    // "Git Repository is empty"，建不了 blob。
    auto_init: true
  }).catch((error) => {
    if (error.status !== 403 && error.status !== 404) throw error
    // fine-grained token 的经典坑：没有 Administration 权限就建不了仓库
    throw new Error(
      `这个令牌建不了仓库（${error.status} ${error.detail?.message ?? ''}）。二选一：\n` +
      '  A) 改这个 fine-grained token：Repository access 选「All repositories」，' +
      '并勾上 Administration: Read and write（建仓库）+ Contents: Read and write（推文件）\n' +
      '  B) 换一个 classic token（只勾 repo）—— https://github.com/settings/tokens/new\n' +
      '  C) 或者干脆在网页上手动建个空仓库（Public，别勾 README/gitignore），再重跑本脚本'
    )
  })
  console.log(`已创建     : ${repo.html_url}`)
}

const branch = repo.default_branch || 'main'

// 2) 已有分支就取它的 head 作为父提交（为空仓库则没有父提交）
let parentSha = null
let baseTreeSha = null
try {
  const ref = await api(token, 'GET', `/repos/${owner}/${REPO}/git/ref/heads/${branch}`)
  parentSha = ref.object.sha
  const parentCommit = await api(token, 'GET', `/repos/${owner}/${REPO}/git/commits/${parentSha}`)
  baseTreeSha = parentCommit.tree.sha
  console.log(`父提交     : ${parentSha.slice(0, 8)}`)
} catch (error) {
  if (error.status !== 404 && error.status !== 409) throw error
  console.log('父提交     : 无（空仓库，创建首个提交）')
}

// 2.5) 空仓库打底：GitHub 的 Git Data API 在空仓库上会 409
//      "Git Repository is empty"（建 blob 都不让），所以先用 Contents API
//      写一个文件把仓库点亮，再拿到它的提交作为父提交。
//      （新建仓库时 auto_init: true 就是为了避免走到这一步；
//       这一步是给"仓库已经存在但还是空的"兜底。）
if (parentSha === null) {
  const seed = files.find((file) => file.path === 'README.md') ?? files[0]
  await api(token, 'PUT', `/repos/${owner}/${REPO}/contents/${seed.path}`, {
    message: 'chore: 初始化仓库',
    content: readFileSync(seed.full).toString('base64'),
    branch
  })
  const ref = await api(token, 'GET', `/repos/${owner}/${REPO}/git/ref/heads/${branch}`)
  parentSha = ref.object.sha
  baseTreeSha = (await api(token, 'GET', `/repos/${owner}/${REPO}/git/commits/${parentSha}`)).tree.sha
  console.log(`打底提交   : ${parentSha.slice(0, 8)}（用 Contents API 写入了 ${seed.path}）`)
}

// 3) 逐个建 blob
const tree = []
for (const file of files) {
  const content = readFileSync(file.full).toString('base64')
  const blob = await api(token, 'POST', `/repos/${owner}/${REPO}/git/blobs`, { content, encoding: 'base64' })
  tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
  process.stdout.write('.')
}
console.log(' blobs ok')

// 4) tree → commit → ref
const newTree = await api(token, 'POST', `/repos/${owner}/${REPO}/git/trees`, {
  ...(baseTreeSha === null ? {} : { base_tree: baseTreeSha }),
  tree
})
const message = readFileSync(join(PACKAGE_ROOT, 'CHANGELOG.md'), 'utf8')
  .split('\n')[0] === '# 更新记录'
  ? `dsh-session-eater v${JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version}`
  : 'update'
const commit = await api(token, 'POST', `/repos/${owner}/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  ...(parentSha === null ? {} : { parents: [parentSha] })
})
if (parentSha === null) {
  await api(token, 'POST', `/repos/${owner}/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
} else {
  await api(token, 'PATCH', `/repos/${owner}/${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false })
}

console.log(`\n✅ 已推送 ${files.length} 个文件 → ${repo.html_url}/commit/${commit.sha}`)
console.log(`   安装命令：dsh plugin --profile web add github:${owner}/${REPO}`)
