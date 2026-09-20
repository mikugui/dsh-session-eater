/**
 * 测试公共件：定位运行中的 dsh web、拿 token、按需加载 profile 里的 puppeteer。
 *
 * 这些测试都对着**正在运行**的 `dsh web` 说话，所以不需要重启、不会影响你正在用的
 * 界面；破坏性动作一律被绕开（合成会话目录 / 拦截 fetch）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ORIGIN = process.env.DSH_TEST_ORIGIN || 'http://127.0.0.1:3080'
export const API = `${ORIGIN}/dsh-session-eater`

/** 解析 DSH home。 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * 从 `dsh web` 的启动日志里取最后一次打印的访问 token。
 * @returns {string} token。
 */
export function readToken() {
  const logPath = process.env.DSH_WEB_LOG || join(process.env.TEMP || '/tmp', 'dsh-web.log')
  const log = readFileSync(logPath, 'utf8')
  const tokens = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)].map((m) => m[1])
  if (tokens.length === 0) throw new Error(`no token found in ${logPath}`)
  return tokens[tokens.length - 1]
}

/**
 * 带上 token 的应用 URL。
 * @param {string} [token] - 覆盖默认 token。
 * @returns {string} URL。
 */
export function appUrl(token = readToken()) {
  return `${ORIGIN}/?token=${token}`
}

/** 运行 web profile 的目录（host 依赖都装在这里）。 */
export function webProfileDir() {
  return process.env.DSH_WEB_PROFILE || join(dshHome(), 'profiles', 'web')
}

/**
 * 加载 profile 里的 puppeteer-core（不额外安装任何东西）。
 * @returns {Promise<any>} puppeteer 模块。
 */
export async function loadPuppeteer() {
  const path = join(webProfileDir(), 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')
  if (!existsSync(path)) throw new Error(`puppeteer-core not found at ${path}`)
  const mod = await import(new URL(`file:///${path.replace(/\\/g, '/')}`).href)
  return mod.default ?? mod
}

/** 可用的 Chromium 内核（Edge / Chrome）。 */
export function browserExecutable() {
  const candidates = [
    process.env.DSH_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (found === undefined) throw new Error('no Edge/Chrome found; set DSH_TEST_BROWSER')
  return found
}

/** 极简断言收集器。 */
export function createReport() {
  const results = []
  return {
    step(name, ok, extra = '') {
      results.push({ name, ok })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`)
    },
    finish() {
      const failed = results.filter((r) => !r.ok)
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
      if (failed.length > 0) console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
      return failed.length
    }
  }
}
