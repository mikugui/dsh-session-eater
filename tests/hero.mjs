/**
 * 生成 README 里的效果图 docs/eating.png —— 真实尺寸下的投放区 + 张嘴。
 *
 * 运行：node tests/hero.mjs
 */
import { browserExecutable, appUrl, loadPuppeteer } from './lib.mjs'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const outDir = fileURLToPath(new URL('../docs/', import.meta.url))
mkdirSync(outDir, { recursive: true })

const puppeteer = await loadPuppeteer()
const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: 'shell', args: ['--no-first-run'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
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

  // 造一条「最近吃掉」台账，这样截图里能看到药丸行右侧的撤销按钮
  // （真实使用中它就是在你吃掉第一条会话之后出现的）。
  await page.evaluate(() => {
    window.localStorage.setItem('dsh-session-eater/eaten', JSON.stringify([
      { sessionId: 'session-00000000-0000-0000-0000-000000000000', title: '一个不想要的旧对话', at: Date.now() - 60000 }
    ]))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 12000))

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
  // 停在"嘴张到最大"的那一相位，避免截到正在合嘴的瞬间
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = '.dse-pet,.dse-mouth,.dse-pet::after{animation-delay:-.25s!important;animation-play-state:paused!important}'
    document.head.append(style)
  })
  await new Promise((r) => setTimeout(r, 500))
  // 整条侧边栏（会话列表 + 投放区 + 底部）一起截，避免写死坐标截偏
  await page.screenshot({ path: `${outDir}eating.png`, clip: { x: 0, y: 150, width: 300, height: 745 } })
  console.log('wrote docs/eating.png')
} finally {
  await browser.close().catch(() => {})
}
