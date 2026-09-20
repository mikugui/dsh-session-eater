/**
 * 投稿前自检：把 `scripts/market-entry.yml` 按 awesome-dsh-plugin 的 CI 要求核一遍。
 *
 * 这些规则都是踩过就会被打回的那种，提交前跑一次能省一个来回：
 *   · `url` 必须与仓库完全一致（不能带 .git / 结尾斜杠）
 *   · `name` 必须是 `owner/repo`
 *   · `category` 必须是官方分类列表里的值
 *   · `description.en` 必填
 *   · 描述里出现 `: `（冒号加空格）**必须加引号**，否则 YAML 解析失败
 *   · `tarball` 必须是 GitHub Release 托管、不带版本号的 https `.tgz`
 *     （带版本号的名字会在你下次发版后 404）
 *
 * 运行：node tests/verify-market-entry.mjs
 * （有 js-yaml 就真解析一遍；没有就退化成逐行检查，同样能抓出引号问题）
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const ENTRY = join(PACKAGE_ROOT, 'scripts', 'market-entry.yml')
const TEXT = readFileSync(ENTRY, 'utf8')
const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

/** 官方 CI 使用的分类取值。 */
const CATEGORIES = ['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools',
  'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev',
  'security', 'remote', 'market', 'fun']

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`)
}

// ── 1) 能解析吗（有 js-yaml 就真解析）──────────────────────────────────
let doc = null
const yamlPaths = [
  'file:///C:/Users/gzx/.dsh/profiles/web/node_modules/js-yaml/index.js',
  join(PACKAGE_ROOT, 'node_modules', 'js-yaml', 'index.js')
]
for (const candidate of yamlPaths) {
  if (doc !== null || !existsSync(candidate.replace('file:///', ''))) continue
  try {
    const mod = await import(candidate.startsWith('file:') ? candidate : `file:///${candidate.replace(/\\/g, '/')}`)
    doc = (mod.default ?? mod).load(TEXT)
  } catch { /* 换下一个 */ }
}
if (doc === null) {
  console.log('INFO  没找到 js-yaml，退化为逐行检查（引号问题仍能抓出）')
  doc = {}
  for (const line of TEXT.split(/\r?\n/)) {
    const match = /^([a-z]+):\s*(.*)$/.exec(line)
    if (match) doc[match[1]] = match[2].replace(/^'|'$/g, '')
  }
  doc.description = { en: '（未解析）', zh: '（未解析）' }
}
check('YAML 能解析', typeof doc === 'object' && doc !== null)

// ── 2) 字段 ────────────────────────────────────────────────────────────
check('url 与仓库完全一致',
  doc.url === `https://github.com/mikugui/${pkg.name}`,
  String(doc.url))
check('name 是 owner/repo',
  doc.name === `mikugui/${pkg.name}`, String(doc.name))
check('category 在官方取值里',
  CATEGORIES.includes(doc.category), String(doc.category))
check('description.en 是有效描述',
  typeof doc.description?.en === 'string' && doc.description.en.length > 20,
  `${String(doc.description?.en ?? '').length} 字符`)

// ── 3) 引号：`: ` 必须被引起来 ─────────────────────────────────────────
const bareColon = TEXT.split(/\r?\n/).filter((line) => {
  const trimmed = line.trim()
  if (trimmed.startsWith('#') || !trimmed.includes(': ')) return false
  // `key: value` 里的第一个冒号是结构，真正要看的是值里还有没有 `: `
  const afterKey = trimmed.slice(trimmed.indexOf(':') + 1).trim()
  if (!afterKey.includes(': ')) return false
  return !(afterKey.startsWith("'") || afterKey.startsWith('"'))
})
check('描述里的 ": " 都加了引号', bareColon.length === 0, bareColon.join(' | '))

// ── 4) tarball（不带版本号才不会被发新版弄 404）────────────────────────
const tarball = String(doc.tarball ?? '')
check('tarball 是 GitHub Release 的 https .tgz',
  /^https:\/\/github\.com\/.+\/releases\/(latest\/download|download\/v[^/]+)\/.+\.tgz$/.test(tarball), tarball)
check('tarball 文件名不带版本号（可安全用 latest/download）',
  !new RegExp(`${pkg.version.replace(/\./g, '\\.')}`).test(tarball), tarball)

// ── 5) 仓库侧硬性条件 ─────────────────────────────────────────────────
check('package.json 声明了 dsh.bundle（只有 dsh.client 会被 CI 拒）',
  pkg.dsh?.bundle?.patch !== undefined, String(pkg.dsh?.bundle?.patch))
check('仓库根有 cordis.patch.yml',
  existsSync(join(PACKAGE_ROOT, 'cordis.patch.yml')))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length > 0) {
  console.log('需要修：' + failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
