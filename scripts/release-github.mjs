/**
 * 在 GitHub 上发一个 Release，并把打包产物作为附件挂上去。
 * 走 REST API，**不需要 git**（这台机器上 github.com:443 不通，只能走 api.github.com）。
 *
 * 用法：
 *   node scripts/release-github.mjs                    # 版本取 package.json，附件自动找
 *   node scripts/release-github.mjs --tag v0.4.0 --dry-run
 *   node scripts/release-github.mjs --assets D:\path\a.tgz,D:\path\b.zip
 *
 * 凭据：环境变量 GITHUB_TOKEN / GITHUB_OWNER，或 <工作区根>/.github-token（同上一个脚本）。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const WORKSPACE_ROOT = join(PACKAGE_ROOT, '..')
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const TAG = value('--tag', `v${pkg.version}`)
const DRY = flag('--dry-run')
const REPO = value('--repo', pkg.name)

const TOKEN_PATTERN = /(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{36}|[0-9a-f]{40})/

/** 读凭据（与环境变量/凭据文件同一套规则）。 */
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
  if (token === '') {
    throw new Error(`凭据文件是空的：把 token 粘到 ${join(WORKSPACE_ROOT, '.github-token')}（只需这一行），或设 GITHUB_TOKEN。`)
  }
  if (!/^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{36}|[0-9a-f]{40})$/.test(token)) {
    throw new Error(`令牌形状可疑（长度 ${token.length}，前缀 "${token.slice(0, 11)}…"）：classic 应为 ghp_ + 36 字符。`)
  }
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
      'user-agent': 'dsh-session-eater-release',
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
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

/** 上传一个附件（走 uploads.github.com 的裸字节接口）。 */
async function uploadAsset(token, owner, repo, releaseId, file) {
  const bytes = readFileSync(file)
  const res = await fetch(
    `${UPLOADS}/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(basename(file))}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'user-agent': 'dsh-session-eater-release'
      },
      body: bytes
    }
  )
  const text = await res.text()
  const json = text === '' ? null : (() => { try { return JSON.parse(text) } catch { return text } })()
  if (!res.ok) {
    const error = new Error(`上传附件 ${basename(file)} → ${res.status} ${json?.message ?? json}`)
    error.status = res.status
    error.detail = json
    throw error
  }
  return json
}

/** 从 CHANGELOG 里抠出这个版本的段落当 release notes。 */
function releaseNotes(version) {
  const text = readFileSync(join(PACKAGE_ROOT, 'CHANGELOG.md'), 'utf8')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start === -1) return `dsh-session-eater ${version}`
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return rest.slice(0, end === -1 ? rest.length : end).join('\n').trim()
}

/** 找附件：优先命令行给的，否则在上一层目录里按版本找 tgz/zip。 */
function findAssets() {
  const explicit = value('--assets', '')
  if (explicit !== '') return explicit.split(',').map((p) => p.trim()).filter(Boolean)
  return readdirSync(WORKSPACE_ROOT)
    .filter((name) => name.endsWith('.tgz') || name.endsWith('.zip'))
    .filter((name) => name.includes(pkg.version))
    .map((name) => join(WORKSPACE_ROOT, name))
}

const assets = findAssets().filter((file) => existsSync(file))

console.log(`发布   : ${REPO}  ${TAG}（--repo 可覆写仓库名）`)
console.log(`附件   : ${assets.length === 0 ? '(无)' : ''}`)
for (const file of assets) console.log(`  ${basename(file)}  ${(statSync(file).size / 1024).toFixed(1)} KB`)
console.log(`notes  : ${releaseNotes(pkg.version).split('\n')[0].slice(0, 60)}…`)
if (DRY) {
  // 同 publish 脚本：dry-run 不能要求凭据，否则"先看看"这件事本身就做不到。
  console.log('\n--dry-run：只列附件与 release notes，不校验凭据、不发布。')
  process.exit(0)
}

const { token, owner: configuredOwner } = credentials()
const user = await api(token, 'GET', '/user')
const owner = configuredOwner || user.login
console.log(`身份   : ${user.login}`)

// 1) 取 main 的 head，必要时打 tag
const ref = await api(token, 'GET', `/repos/${owner}/${REPO}/git/ref/heads/${(await api(token, 'GET', `/repos/${owner}/${REPO}`)).default_branch}`)
const headSha = ref.object.sha
console.log(`目标提交: ${headSha.slice(0, 8)}`)

let existingRelease = null
try {
  existingRelease = await api(token, 'GET', `/repos/${owner}/${REPO}/releases/tags/${TAG}`)
  console.log(`已存在   : Release ${TAG}（将复用，附件缺失会补传）`)
} catch (error) {
  if (error.status !== 404) throw error
}

if (existingRelease === null) {
  try {
    await api(token, 'POST', `/repos/${owner}/${REPO}/git/refs`, { ref: `refs/tags/${TAG}`, sha: headSha })
    console.log(`已打 tag : ${TAG} → ${headSha.slice(0, 8)}`)
  } catch (error) {
    if (error.status !== 422) throw error // 422 = tag 已存在
    console.log(`tag 已存在: ${TAG}`)
  }
  existingRelease = await api(token, 'POST', `/repos/${owner}/${REPO}/releases`, {
    tag_name: TAG,
    name: `${pkg.name} ${TAG}`,
    body: releaseNotes(pkg.version),
    draft: false,
    prerelease: false
  })
  console.log(`已发布   : ${existingRelease.html_url}`)
}

// 2) 传附件（已存在同名附件就跳过）
const uploaded = new Set((existingRelease.assets ?? []).map((asset) => asset.name))
for (const file of assets) {
  const name = basename(file)
  if (uploaded.has(name)) {
    console.log(`跳过     : ${name}（已存在）`)
    continue
  }
  const asset = await uploadAsset(token, owner, REPO, existingRelease.id, file)
  console.log(`已上传   : ${asset.name}  ${(asset.size / 1024).toFixed(1)} KB`)
}

// 3) 再补一个**不带版本号**的 tgz。
//    市场条目里的 tarball 写的是 `releases/latest/download/<name>.tgz`：latest 在请求时解析，
//    但**文件名是照字面取的** —— 所以每个 Release 都得带上这个不带版本号的名字，
//    否则下一次发版这个链接就 404（官方 CI 指南专门警告过这一点）。
//
//    ⚠️ GitHub 的 release 附件名是**仓库级唯一**，不是每个 Release 各自一份：
//    v0.4.1 已经占着 `dsh-session-eater.tgz`，直接往 v0.5.0 传会 422 already_exists。
//    所以这里先把这个名字从**别的** Release 上摘下来，再传到当前 Release —— 这样
//    `latest/download/` 永远指向最新那份，而旧 Release 的带版本号附件一个不动。
const stableName = `${pkg.name}.tgz`
const stableSource = assets.find((file) => file.endsWith('.tgz'))
if (stableSource === undefined) {
  console.log(`提示     : 没有 tgz，跳过 ${stableName}`)
} else {
  const allReleases = await api(token, 'GET', `/repos/${owner}/${REPO}/releases`)
  for (const release of allReleases) {
    if (release.tag_name === TAG) continue
    for (const asset of release.assets ?? []) {
      if (asset.name !== stableName) continue
      await api(token, 'DELETE', `/repos/${owner}/${REPO}/releases/assets/${asset.id}`)
      console.log(`腾名字   : 从 ${release.tag_name} 摘掉 ${stableName}（仓库级唯一，先让它空出来）`)
    }
  }
  const stillThere = (existingRelease.assets ?? []).some((asset) => asset.name === stableName)
  if (stillThere) {
    console.log(`跳过     : ${stableName}（这个 Release 已经有了）`)
  } else {
    const asset = await uploadAsset(token, owner, REPO, existingRelease.id, stableSource, stableName)
    console.log(`已上传   : ${asset.name}  ${(asset.size / 1024).toFixed(1)} KB  ← 市场 latest/download 靠它`)
  }
}

const final = await api(token, 'GET', `/repos/${owner}/${REPO}/releases/tags/${TAG}`)
console.log(`\n✅ Release: ${final.html_url}`)
for (const asset of final.assets ?? []) {
  console.log(`   ${asset.name}  →  ${asset.browser_download_url}`)
}
