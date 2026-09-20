/**
 * 把「咀嚼」动画导成**循环动图**，用来做视频片头 / 封面预览 / README 展示。
 *
 * 手法与 filmstrip.mjs 同源：先合成拖拽把投放区武装起来（`data-over="true"`），
 * 再用负 `animation-delay` + `animation-play-state:paused` 把动画冻在周期里的不同相位。
 * 区别在于这里是**逐帧单独截图**，并带 `omitBackground` —— `.dse-pet` 自己没有背景色，
 * 所以导出的帧是**透明背景**的，能直接叠到视频/任意底色上。
 *
 * 运行：node tests/loop.mjs [帧数]        （默认 18 帧；一个周期 0.54s → 每帧 30ms）
 *
 * 产物：
 *   docs/chew-loop.gif        原速循环（0.54s），通用性最好
 *   docs/chew-loop-slow.gif   3 倍慢（1.62s），做片头更好读
 *   docs/chew-loop.webp       带 8 位 alpha，叠背景不会有 GIF 的锯齿边
 *   <工作区>/_loop-frames/    透明 PNG 序列，可直接倒进剪辑软件（不入库）
 *
 * 需要 sharp（只用来拼动画，不属于插件依赖）：脚本会从 DSH profile 的 node_modules 里找。
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserExecutable, appUrl, loadPuppeteer } from './lib.mjs'

const frames = Number(process.argv[2] || 18)
const cycle = 0.54
const SIZE = 220
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const OUT_DIR = fileURLToPath(new URL('../docs/', import.meta.url))
const FRAME_DIR = fileURLToPath(new URL('../../_loop-frames/', import.meta.url))

/** sharp 只用来拼动画，从 DSH profile 的 node_modules 里借用，不写进插件依赖。 */
function loadSharp() {
  const require = createRequire(import.meta.url)
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const roots = [
    join(PACKAGE_ROOT, 'node_modules'),
    join(home, 'profiles', 'web', 'node_modules'),
    join(home, 'profiles', 'node_modules')
  ]
  for (const base of roots) {
    try { return require(require.resolve('sharp', { paths: [base] })) } catch { /* 换下一个 */ }
  }
  throw new Error('找不到 sharp。它只用于拼动画，装一个即可：npm i -D sharp')
}

rmSync(FRAME_DIR, { recursive: true, force: true })
mkdirSync(FRAME_DIR, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

const puppeteer = await loadPuppeteer()
const browser = await puppeteer.launch({
  executablePath: browserExecutable(),
  headless: 'shell',
  args: ['--no-first-run']
})

const framePaths = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 700, deviceScaleFactor: 2 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
  // 拦截插件的宿主请求，免得在测试里真去动会话
  await page.evaluateOnNewDocument(() => {
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.includes('/dsh-session-eater/')) {
        return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return original(input, init)
    }
  })
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 12000))

  // 武装投放区：dragstart 会话行 → 在投放区上 dragenter/dragover
  const SID = 'session-00000000-0000-0000-0000-000000000000'
  await page.evaluate((sid) => {
    const t = new DataTransfer()
    t.setData('text/plain', sid)
    const row = [...document.querySelectorAll("[class*='sessionRow']")].find((el) => !/selected/i.test(el.className))
      ?? document.querySelector("[class*='sessionRow']")
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: t }))
  }, SID)
  await new Promise((r) => setTimeout(r, 350))
  await page.evaluate((sid) => {
    const t = new DataTransfer()
    t.setData('text/plain', sid)
    const plate = document.querySelector('.dse-plate')
    plate.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: t }))
    plate.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: t }))
  }, SID)
  await new Promise((r) => setTimeout(r, 500))

  // 只放一个克隆体，逐帧改相位后截图 —— 不依赖超出视口的元素截图，版式最稳
  const prepared = await page.evaluate((size) => {
    const pet = document.querySelector('.dse-pet')
    if (!pet) return false
    const cell = document.createElement('div')
    cell.id = 'dse-loop-cell'
    // 透明底 + 留白：嘴是 overflow:visible 的，留白免得被裁掉
    cell.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;padding:24px;background:transparent'
    const clone = pet.cloneNode(true)
    clone.setAttribute('data-loop', '0')
    clone.style.setProperty('--dse-size', `${size}px`)
    cell.append(clone)
    const style = document.createElement('style')
    style.id = 'dse-loop-style'
    document.head.append(style)
    document.body.append(cell)
    // 关键：`omitBackground` 只去掉页面默认白底，应用自己的背景层还在后面 ——
    // 必须把除拍摄对象外的整个 UI 设成 visibility:hidden，才能真的拿到透明帧；
    // 另外 html/body 自己的 background 会直接画在 canvas 上，得显式清掉。
    document.documentElement.style.setProperty('background', 'transparent', 'important')
    document.body.style.setProperty('background', 'transparent', 'important')
    const hide = document.createElement('style')
    hide.textContent = 'html,body{background:transparent!important;background-image:none!important}'
      + 'body > *:not(#dse-loop-cell){visibility:hidden!important}'
      + '#dse-loop-cell,#dse-loop-cell *{visibility:visible!important}'
    document.head.append(hide)
    return pet.getAttribute('data-over') === 'true'
  }, SIZE)
  if (!prepared) throw new Error('没找到 .dse-pet，或它没进入 data-over 状态 —— 插件加载了吗？')

  const cell = await page.$('#dse-loop-cell')
  for (let i = 0; i < frames; i += 1) {
    await page.evaluate(({ i, n, t }) => {
      const delay = (-(i / n) * t).toFixed(4)
      document.querySelector('#dse-loop-style').textContent =
        `[data-loop="0"],[data-loop="0"]::after,[data-loop="0"] .dse-mouth{`
        + `animation-delay:${delay}s!important;animation-play-state:paused!important}`
    }, { i, n: frames, t: cycle })
    // 等两帧确保重绘完成（暂停的动画改 delay 会立刻换相位）
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const file = join(FRAME_DIR, `f${String(i).padStart(3, '0')}.png`)
    await cell.screenshot({ path: file, omitBackground: true })
    framePaths.push(file)
  }
  console.log(`已截 ${framePaths.length} 帧 → ${FRAME_DIR}`)
} finally {
  await browser.close().catch(() => {})
}

// ── 拼动画 ──────────────────────────────────────────────────────────────
const sharp = loadSharp()
const buffers = framePaths.map((file) => readFileSync(file))
const meta = await sharp(buffers[0]).metadata()

// 透明检查：数一下真正透明的像素占比，免得"以为透明其实贴了一层底色"
const { data: rgba, info: rgbaInfo } = await sharp(buffers[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
let transparent = 0
for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 8) transparent += 1
const transparentShare = transparent / (rgbaInfo.width * rgbaInfo.height)
console.log(`单帧 ${meta.width}x${meta.height}  有 alpha=${meta.hasAlpha}  透明像素占比=${(transparentShare * 100).toFixed(1)}%`)
if (transparentShare < 0.05) {
  console.log('  注意：几乎不透明 —— 说明应用底色还是被拍进去了（omitBackground 只清默认白底）')
}

const stepMs = Math.round(((cycle * 1000) / frames) / 10) * 10
const outputs = []

// GIF：通用性最好（微信/B站预览/README 都能直接显示）
for (const [name, delay] of [['chew-loop.gif', stepMs], ['chew-loop-slow.gif', stepMs * 3]]) {
  const out = join(OUT_DIR, name)
  await sharp(buffers, { join: { animated: true } })
    .gif({ delay: buffers.map(() => delay), loop: 0, effort: 7, colours: 256, dither: 0.6 })
    .toFile(out)
  outputs.push([name, out, delay])
}

// WebP：8 位 alpha，叠到任何底色上都不出锯齿
const webpOut = join(OUT_DIR, 'chew-loop.webp')
await sharp(buffers, { join: { animated: true } })
  .webp({ delay: buffers.map(() => stepMs), loop: 0, quality: 88, effort: 5 })
  .toFile(webpOut)
outputs.push(['chew-loop.webp', webpOut, stepMs])

// 深色底版本：不用管 alpha，直接拖进剪辑软件当片头就能用
const darkBg = { r: 14, g: 19, b: 34 }
const dark = []
for (const buffer of buffers) {
  dark.push(await sharp(buffer).flatten({ background: darkBg }).png().toBuffer())
}
const darkOut = join(OUT_DIR, 'chew-loop-dark.gif')
await sharp(dark, { join: { animated: true } })
  .gif({ delay: dark.map(() => stepMs * 3), loop: 0, effort: 7, colours: 256, dither: 0.6 })
  .toFile(darkOut)
outputs.push(['chew-loop-dark.gif', darkOut, stepMs * 3])

writeFileSync(join(FRAME_DIR, 'README.txt'),
  `透明 PNG 序列（${frames} 帧，一个咀嚼周期 ${cycle}s，每帧 ${stepMs}ms）\n`
  + '可直接导入剪辑软件当叠层/序列帧：复制到工程里，按 f000.png…f0' + (frames - 1) + '.png 顺序排列即可。\n')

console.log('')
for (const [name, file, delay] of outputs) {
  console.log(`  ${name.padEnd(20)} ${String(Math.round(statSync(file).size / 1024)).padStart(5)} KB   每帧 ${delay}ms  共 ${(delay * frames / 1000).toFixed(2)}s`)
}
console.log(`  帧序列 ${frames} 张 → ${FRAME_DIR}`)
