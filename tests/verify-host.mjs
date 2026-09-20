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

// --- 收尾 -----------------------------------------------------------------
for (const name of buckets) rmSync(join(TRASH, name), { recursive: true, force: true })
if (existsSync(TRASH) && readdirSync(TRASH).length === 0) rmSync(TRASH, { recursive: true, force: true })
rmSync(BUCKET, { recursive: true, force: true })
report.step('fixture cleaned up', !existsSync(DIR))

process.exit(report.finish())
