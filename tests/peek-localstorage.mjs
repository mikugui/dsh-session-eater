/**
 * 读浏览器里真正存着的插件配置（排查"我的设置怎么是这样"这类问题）。
 *
 * localStorage 在 Chromium 系里存在 LevelDB（`Local Storage/leveldb/`）。
 * 两个坑：
 *   1. **key 是 ASCII，value 是 UTF-16LE** —— 必须混着解，整文件按一种编码解都读不出来；
 *   2. `.log` 是当前写入的文件，历史值在 `.ldb` 里，两处都要扫。
 *
 * 用法：
 *   node tests/peek-localstorage.mjs                     # 自动找 Edge / WebView2
 *   node tests/peek-localstorage.mjs "<leveldb 目录>"
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const KEY = 'dsh-session-eater/config'
const EATEN_KEY = 'dsh-session-eater/eaten'

const CANDIDATES = [
  process.argv[2],
  join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/User Data/Default/Local Storage/leveldb'),
  join(process.env.LOCALAPPDATA || '', 'com.deepseek.dsh.desktop.tauri/EBWebView/Default/Local Storage/leveldb'),
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data/Default/Local Storage/leveldb'),
].filter(Boolean)

/**
 * key 用 latin1 定位，value 用 utf16le 解码，配平出 JSON。
 * @param {Buffer} buf - LevelDB 文件内容。
 * @param {string} key - localStorage 的键。
 * @returns {Array<{at: number, value: unknown}>} 命中的值（旧→新）。
 */
function extract(buf, key) {
  const needle = Buffer.from(key, 'latin1')
  const hits = []
  let from = 0
  while (true) {
    const at = buf.indexOf(needle, from)
    if (at === -1) break
    from = at + needle.length
    const text = buf.subarray(at).toString('utf16le')
    const brace = text.indexOf('{')
    if (brace === -1) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = brace; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try { hits.push({ at, value: JSON.parse(text.slice(brace, i + 1)) }) } catch { /* 跨文件边界，忽略 */ }
          break
        }
      }
    }
  }
  return hits
}

const dir = CANDIDATES.find((candidate) => candidate && existsSync(candidate))
if (dir === undefined) {
  console.error('没找到 LevelDB 目录；把路径作为参数传进来。')
  process.exit(1)
}
console.log(`LevelDB: ${dir}\n`)

/** 文件名里带数字的越大越新，人类可读地排序一下。 */
const files = readdirSync(dir).filter((name) => /\.(log|ldb)$/.test(name))

for (const key of [KEY, EATEN_KEY]) {
  const all = []
  for (const name of files) {
    for (const hit of extract(readFileSync(join(dir, name)), key)) all.push({ name, ...hit })
  }
  console.log(`=== ${key} ===`)
  if (all.length === 0) {
    console.log('(没有任何记录 —— 这个浏览器里还没写过)\n')
    continue
  }
  // 最新的一条放最后打印（.log 是当前写入的）
  const latest = all[all.length - 1]
  console.log(`共 ${all.length} 条记录；最新的在 ${latest.name}\n`)
  console.log(JSON.stringify(latest.value, null, 1))
  if (key === KEY && latest.value !== null && typeof latest.value === 'object') {
    if (latest.value.text === undefined) {
      console.log('\n注意：这条配置里没有 text 块 —— 是加文案功能之前的版本写的，' +
        '新版加载时会自动补上出厂文案。')
    } else if (latest.value.text.restore === '') {
      console.log('\n注意：text.restore 是空串 —— 按设计「撤销按钮」会被隐藏。')
    }
  }
  console.log()
}
