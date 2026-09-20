/**
 * 动画检视工具：把「咀嚼」一个周期的关键帧拼成一张 contact sheet。
 *
 * 做法：武装 + 悬停让形象进入 data-over 状态，然后把 .dse-pet 克隆成一排，
 * 每个克隆用负 animation-delay 冻结在周期的不同相位（animation-play-state: paused），
 * 最后截一张图。改嘴形/动效时用它一眼看出好不好看。
 *
 * 运行：node tests/filmstrip.mjs [帧数]
 */
import { browserExecutable, appUrl, loadPuppeteer } from './lib.mjs'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const frames = Number(process.argv[2] || 8)
const cycle = 0.54
const outDir = fileURLToPath(new URL('../docs/', import.meta.url))
mkdirSync(outDir, { recursive: true })

const puppeteer = await loadPuppeteer()
const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: 'shell', args: ['--no-first-run'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1500, height: 420, deviceScaleFactor: 2 })
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

  const ok = await page.evaluate(({ n, cycle: t }) => {
    const pet = document.querySelector('.dse-pet')
    if (!pet) return false
    const strip = document.createElement('div')
    strip.id = 'dse-filmstrip'
    strip.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;display:flex;align-items:center;gap:0;'
      + 'background:linear-gradient(180deg,#141a2e,#0e1322);padding:24px 12px;'
    let css = ''
    for (let i = 0; i < n; i += 1) {
      const clone = pet.cloneNode(true)
      clone.setAttribute('data-fs', String(i))
      clone.style.setProperty('--dse-size', '180px')
      clone.style.margin = '0 4px'
      const label = document.createElement('div')
      label.textContent = `${Math.round((i / n) * 100)}%`
      label.style.cssText = 'position:absolute;bottom:2px;left:0;right:0;text-align:center;color:#8f9ab8;font:11px monospace'
      const cell = document.createElement('div')
      cell.style.cssText = 'position:relative;padding-bottom:16px'
      cell.append(clone, label)
      strip.append(cell)
      const delay = (-(i / n) * t).toFixed(4)
      css += `[data-fs="${i}"],[data-fs="${i}"]::after,[data-fs="${i}"] .dse-mouth{`
        + `animation-delay:${delay}s!important;animation-play-state:paused!important}`
    }
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    document.body.append(strip)
    return true
  }, { n: frames, cycle })

  if (!ok) throw new Error('pet element not found — is the plugin loaded?')
  await new Promise((r) => setTimeout(r, 400))
  const strip = await page.$('#dse-filmstrip')
  const path = `${outDir}chew-cycle.png`
  await strip.screenshot({ path })
  console.log(`wrote docs/chew-cycle.png (${frames} frames of ${cycle}s)`)
} finally {
  await browser.close().catch(() => {})
}
