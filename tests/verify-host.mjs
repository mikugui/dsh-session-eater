/**
 * 宿主半边契约测试。
 *
 * 用**合成的**会话目录（`session-eater-selftest-*`）验证 /delete 的完整链路：
 * 路径穿越拒绝 → 目录被移进回收站且内容完好 → 删不存在的会话幂等 → 清理现场。
 * 全程不碰任何真实对话。
 *
 * 运行：node tests/verify-host.mjs
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API, createReport, dshHome, readToken } from './lib.mjs'
// 直接 import 宿主的读函数：路由要重启才生效，但读逻辑本身现在就能测。
import { sessionTokenUsage } from '../lib/index.js'

const SESSION_ID = 'session-eater-selftest-0001'
const HOME = dshHome()
const BUCKET = join(HOME, 'sessions', '--eater-selftest--')
const DIR = join(BUCKET, SESSION_ID)
const TRASH = join(HOME, 'session-eater-trash')
const TOKEN = readToken()
const report = createReport()

const post = (route, body) => fetch(`${API}/${route}?token=${TOKEN}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

// --- 现场准备 -------------------------------------------------------------
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true })
// 上一次跑崩了（没走到收尾）会在回收站里留下同名目录，让「搬进回收站」那条断言数到两个 —— 先清掉。
if (existsSync(TRASH)) {
  for (const name of readdirSync(TRASH)) {
    if (name.endsWith(SESSION_ID)) rmSync(join(TRASH, name), { recursive: true, force: true })
  }
}
mkdirSync(DIR, { recursive: true })
writeFileSync(join(DIR, 'session.v3.jsonl.zstd'), Buffer.from('synthetic'))
writeFileSync(join(DIR, 'attachment.bin'), 'x')
report.step('synthetic session fixture created', existsSync(DIR), DIR)

// --- 自检路由（诊断用；老版本宿主上这个路由会 400，不影响功能）------------
const status = await fetch(`${API}/status?token=${TOKEN}`)
const statusBody = await status.text()
console.log(`INFO  /status -> ${status.status} ${statusBody.slice(0, 160)}`)

// --- 输入校验 -------------------------------------------------------------
const traversal = await post('delete', { sessionId: '../../etc/passwd' })
report.step('path traversal rejected with 400', traversal.status === 400, `HTTP ${traversal.status}`)

const wrongMethod = await fetch(`${API}/delete?token=${TOKEN}`)
report.step('GET /delete rejected with 405', wrongMethod.status === 405, `HTTP ${wrongMethod.status}`)

// --- 真删除（合成会话）----------------------------------------------------
const deleted = await post('delete', { sessionId: SESSION_ID })
const payload = await deleted.json().catch(() => null)
report.step('delete accepted', deleted.status === 200 && payload?.ok === true, JSON.stringify(payload))
report.step('source directory removed', !existsSync(DIR))
const buckets = existsSync(TRASH) ? readdirSync(TRASH).filter((n) => n.endsWith(SESSION_ID)) : []
report.step('directory moved into the trash', buckets.length === 1, buckets.join(','))
if (buckets.length === 1) {
  const inside = readdirSync(join(TRASH, buckets[0]))
  report.step('trashed content intact',
    inside.includes('session.v3.jsonl.zstd') && inside.includes('attachment.bin'),
    inside.join(','))
}

// --- 幂等 -----------------------------------------------------------------
const missing = await post('delete', { sessionId: 'session-eater-selftest-absent' })
report.step('deleting a missing session is idempotent', missing.status === 200 && (await missing.json()).ok === true)

// --- /usage：确认弹窗要显示"这个会话消耗了多少 token" --------------------
// 数据来自内核的会话投影缓存（storages/session_projcache/sessions/<id>.json）。
//
// 分两层测：
// 1) **直接 import 宿主的读函数** —— 这层不依赖任何运行中的服务，逻辑对不对立刻见分晓；
// 2) HTTP 路由那一层要**重启 dsh web** 才生效，所以"还没重启"时显式 SKIP，不报假失败。
const projDir = join(HOME, 'storages', 'session_projcache', 'sessions')
const realId = existsSync(projDir)
  ? readdirSync(projDir).find((n) => n.startsWith('session-') && n.endsWith('.json'))?.replace(/\.json$/, '')
  : undefined

const direct = await sessionTokenUsage(HOME, 'session-does-not-exist-0000')
report.step('读不存在的会话：total 为 null 且给出原因（不是抛错）',
  direct.total === null && typeof direct.reason === 'string', JSON.stringify(direct))

if (realId === undefined) {
  console.log('SKIP  本机还没有会话投影缓存，跳过真实会话的用量断言')
} else {
  const real = await sessionTokenUsage(HOME, realId)
  report.step('真实会话能读出正的 token 总量',
    typeof real.total === 'number' && real.total > 0,
    `${realId.slice(0, 20)}… total=${real.total} turns=${real.turns} steps=${real.steps}`)
  report.step('总量 = 未缓存输入 + 输出 + 缓存读 + 缓存写',
    real.total === real.uncachedInputTokens + real.outputTokens + real.cacheReadTokens + real.cacheWriteTokens,
    `${real.total} = ${real.uncachedInputTokens} + ${real.outputTokens} + ${real.cacheReadTokens} + ${real.cacheWriteTokens}`)
  report.step('顺带读出了轮数与步数（弹窗副信息要用）',
    real.turns > 0 && real.steps > 0, `turns=${real.turns} steps=${real.steps}`)
}

// HTTP 路由层（要重启才在）
const usage = await post('usage', { sessionId: SESSION_ID })
if (usage.status !== 200) {
  console.log(`SKIP  /usage 路由还没上（HTTP ${usage.status}）—— 宿主侧改动要重启 dsh web 才生效，重启后再跑`)
} else {
  const usageBody = await usage.json().catch(() => null)
  report.step('/usage 接受 POST 并返回 ok',
    usageBody?.ok === true, JSON.stringify(usageBody)?.slice(0, 120))
  report.step('合成会话没有投影缓存时 total 是 null（不算错误）',
    usageBody?.total === null && typeof usageBody?.reason === 'string',
    `total=${JSON.stringify(usageBody?.total)} reason=${usageBody?.reason}`)
  const usageGet = await fetch(`${API}/usage?token=${TOKEN}`)
  report.step('GET /usage rejected with 405', usageGet.status === 405, `HTTP ${usageGet.status}`)
  const usageBad = await post('usage', { sessionId: '../../etc/passwd' })
  report.step('/usage 同样拒绝路径穿越（400）', usageBad.status === 400, `HTTP ${usageBad.status}`)
  if (realId !== undefined) {
    const viaHttp = await (await post('usage', { sessionId: realId })).json().catch(() => null)
    report.step('HTTP 读到的总量和直连逻辑一致',
      viaHttp?.total === (await sessionTokenUsage(HOME, realId)).total,
      `http=${viaHttp?.total}`)
  }
}

// --- 收尾 -----------------------------------------------------------------
for (const name of buckets) rmSync(join(TRASH, name), { recursive: true, force: true })
if (existsSync(TRASH) && readdirSync(TRASH).length === 0) rmSync(TRASH, { recursive: true, force: true })
rmSync(BUCKET, { recursive: true, force: true })
report.step('fixture cleaned up', !existsSync(DIR))

process.exit(report.finish())
