/**
 * 设置页端到端测试：真实浏览器 + 真实设置面板。
 *
 * 覆盖：
 *   1. 设置页里出现「会话喂鱼」入口并能打开
 *   2. 上传一张**非正方形**图片 → 形象换成它，嘴按 object-fit:contain 的显示矩形正确落位
 *   3. 在预览框里点击 → 嘴心跟过去（自定义图的校准路径）
 *   4. 「药丸头像」滑块 → 侧边栏药丸头像实际跟着变
 *   5. 「投放区」滑块 → 武装拖拽后投放区形象实际跟着变
 *   6. 刷新页面后配置仍在（localStorage）
 *   7. 恢复全部默认
 *
 * 安全性：页面里 fetch 被打桩，不会发出任何删除请求。
 *
 * 运行：node tests/verify-settings.mjs
 */
import { browserExecutable, appUrl, createReport, loadPuppeteer } from './lib.mjs'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(new URL('./fixtures/test-face-240x160.png', import.meta.url))
const NAT = { w: 240, h: 160 }
const STAGE = 240
/** 测试里挑一个明显偏离默认值的目标点（图片内百分比）。 */
const TARGET = { x: 30, y: 25 }
const CONFIG_KEY = 'dsh-session-eater/config'

const report = createReport()
const puppeteer = await loadPuppeteer()
const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: 'shell', args: ['--no-first-run'] })

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 950 })
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

  /** 从干净状态开始：清掉上次测试留下的配置再刷新。 */
  await page.evaluate((key) => window.localStorage.removeItem(key), CONFIG_KEY)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 12000))

  // 打开设置面板并切到「会话喂鱼」分区（设置面板会记住上次的分区，所以每次都要点一下）
  const openSection = async () => {
    if (await page.evaluate(() => document.querySelector('.dse-cfg') !== null)) return
    await page.click("[data-slot='sidebar.settings'] button")
    await new Promise((r) => setTimeout(r, 900))
    await page.evaluate(() => {
      const node = [...document.querySelectorAll("[role='dialog'] *")]
        .reverse()
        .find((el) => el.children.length === 0 && el.textContent.trim() === '会话喂鱼')
      node?.click()
    })
    await new Promise((r) => setTimeout(r, 800))
  }

  // ── 1. 打开设置页 ───────────────────────────────────────────────────
  await page.click("[data-slot='sidebar.settings'] button")
  await new Promise((r) => setTimeout(r, 900))
  const opened = await page.evaluate(() => {
    const dialog = document.querySelector("[role='dialog']")
    const navText = dialog ? dialog.innerText : ''
    return { hasDialog: dialog !== null, hasEntry: navText.includes('会话喂鱼') }
  })
  report.step('settings dialog opens with the 会话喂鱼 entry', opened.hasDialog && opened.hasEntry, JSON.stringify(opened))
  if (!opened.hasEntry) throw new Error('会话喂鱼 section not registered')

  await page.evaluate(() => {
    const node = [...document.querySelectorAll("[role='dialog'] *")]
      .reverse()
      .find((el) => el.children.length === 0 && el.textContent.trim() === '会话喂鱼')
    node?.click()
  })
  await new Promise((r) => setTimeout(r, 700))
  const panel = await page.evaluate(() => ({
    hasConfig: document.querySelector('.dse-cfg') !== null,
    blocks: [...document.querySelectorAll('.dse-cfg h3')].map((h) => h.textContent),
    stage: document.querySelector('.dse-cfg-stage') !== null
  }))
  report.step('配置面板渲染出全部分组', panel.hasConfig && panel.blocks.length >= 4, panel.blocks.join(' / '))
  report.step('预览框存在', panel.stage)
  await page.screenshot({ path: fileURLToPath(new URL('../docs/settings.png', import.meta.url)) })

  // ── 2. 上传非正方形图片 ─────────────────────────────────────────────
  const input = await page.$('.dse-cfg input[type="file"]')
  report.step('自定义模式提供文件选择', input !== null)
  if (input !== null) await input.uploadFile(FIXTURE)
  await new Promise((r) => setTimeout(r, 1200))

  const applied = await page.evaluate((key) => {
    const cfg = JSON.parse(window.localStorage.getItem(key) || '{}')
    const img = document.querySelector('.dse-cfg-stage .dse-pet img')
    return {
      mode: cfg.image?.mode,
      isDataUrl: String(cfg.image?.custom || '').startsWith('data:image/'),
      mouthMode: cfg.mouth?.mode,
      rendered: String(img?.src || '').startsWith('data:image/')
    }
  }, CONFIG_KEY)
  report.step('上传后切成自定义形象', applied.mode === 'custom' && applied.isDataUrl, JSON.stringify(applied))
  report.step('预览与侧边栏真的用上了这张图', applied.rendered === true)
  report.step('上传后自动打开画嘴', applied.mouthMode === 'on', String(applied.mouthMode))

  // 嘴应当落在图片显示区（240×160 居中 → 上下各留 40px），而不是整个正方形框
  const geom = await page.evaluate(() => {
    const stage = document.querySelector('.dse-cfg-stage')
    const mouth = document.querySelector('.dse-cfg-stage .dse-mouth')
    if (!stage || !mouth) return null
    const s = stage.getBoundingClientRect()
    const m = mouth.getBoundingClientRect()
    return {
      centerX: Math.round(m.left + m.width / 2 - s.left),
      centerY: Math.round(m.top + m.height / 2 - s.top),
      w: Math.round(m.width),
      h: Math.round(m.height)
    }
  })
  // 默认嘴心 52% / 72.5%，图片显示区 = x∈[0,240] y∈[40,200]
  const expectX = Math.round((52 / 100) * NAT.w)
  const expectY = Math.round(40 + (72.5 / 100) * NAT.h)
  report.step('嘴按 contain 后的显示矩形落位（不是按正方形框）',
    geom !== null && Math.abs(geom.centerX - expectX) <= 3 && Math.abs(geom.centerY - expectY) <= 3,
    `实际 (${geom?.centerX},${geom?.centerY}) 期望 (${expectX},${expectY})`)

  // ── 3. 预览框点击 → 校准嘴心 ────────────────────────────────────────
  const stageBox = await page.evaluate(() => {
    const s = document.querySelector('.dse-cfg-stage').getBoundingClientRect()
    return { x: s.left, y: s.top, w: s.width, h: s.height }
  })
  // 目标在"图片内百分比" → 显示矩形内坐标（图片 240×160 居中于 240 框）
  await page.mouse.click(
    stageBox.x + (TARGET.x / 100) * NAT.w,
    stageBox.y + 40 + (TARGET.y / 100) * NAT.h
  )
  await new Promise((r) => setTimeout(r, 500))
  const moved = await page.evaluate((key) => {
    const cfg = JSON.parse(window.localStorage.getItem(key) || '{}')
    return { x: cfg.mouth?.x, y: cfg.mouth?.y }
  }, CONFIG_KEY)
  report.step('点击预览框能校准嘴心',
    Math.abs(moved.x - TARGET.x) <= 2 && Math.abs(moved.y - TARGET.y) <= 2,
    `配置 (${moved.x},${moved.y}) 目标 (${TARGET.x},${TARGET.y})`)

  // ── 4. 药丸头像尺寸 ─────────────────────────────────────────────────
  const setRange = async (index, value) => {
    await page.evaluate(({ i, v }) => {
      const inputs = [...document.querySelectorAll('.dse-cfg input[type="range"]')]
      const input = inputs[i]
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(v))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, { i: index, v: value })
    await new Promise((r) => setTimeout(r, 400))
  }
  // 滑块顺序：0 = 嘴大小，1 = 投放区，2 = 药丸头像，3 = 咀嚼周期
  await setRange(2, 40)
  const pill = await page.evaluate(() => {
    const head = document.querySelector('.dse-pill-head')
    const cfg = JSON.parse(window.localStorage.getItem('dsh-session-eater/config') || '{}')
    return { styleW: head?.style.width ?? null, cfg: cfg.pillSize }
  })
  report.step('药丸头像尺寸改动生效', pill.cfg === 40 && pill.styleW === '40px', JSON.stringify(pill))

  await setRange(1, 170)
  const sizeCfg = await page.evaluate(() => JSON.parse(window.localStorage.getItem('dsh-session-eater/config') || '{}').size)
  report.step('投放区尺寸写入配置', sizeCfg === 170, String(sizeCfg))

  // ── 5. 刷新后配置仍在 ───────────────────────────────────────────────
  await page.reload({ waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 12000))
  const afterReload = await page.evaluate((key) => {
    const cfg = JSON.parse(window.localStorage.getItem(key) || '{}')
    const head = document.querySelector('.dse-pill-head')
    const img = head?.querySelector('img')
    return {
      size: cfg.size, pillSize: cfg.pillSize, mode: cfg.image?.mode,
      headW: head?.style.width ?? null,
      custom: String(img?.src || '').startsWith('data:image/')
    }
  }, CONFIG_KEY)
  report.step('刷新后配置与自定义图标都还在',
    afterReload.size === 170 && afterReload.pillSize === 40 && afterReload.custom === true,
    JSON.stringify(afterReload))

  // ── 6. 投放区真的用上了新尺寸 ───────────────────────────────────────
  await page.evaluate(() => {
    const t = new DataTransfer()
    t.setData('text/plain', 'session-00000000-0000-0000-0000-000000000000')
    const row = [...document.querySelectorAll("[class*='sessionRow']")].find((el) => !/selected/i.test(el.className))
      ?? document.querySelector("[class*='sessionRow']")
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: t }))
  })
  await new Promise((r) => setTimeout(r, 500))
  const platePet = await page.evaluate(() => {
    const pet = document.querySelector('.dse-plate .dse-pet')
    const img = pet?.querySelector('img')
    return { w: pet?.getBoundingClientRect().width ?? null, custom: String(img?.src || '').startsWith('data:image/') }
  })
  report.step('投放区形象用上了自定义图标与新尺寸',
    platePet.w === 170 && platePet.custom === true, JSON.stringify(platePet))

  // ── 6.5 文案可自定义 / 可留空 ───────────────────────────────────────
  // 先收掉上一步留下的拖拽状态，否则药丸停在 armed 相位上
  await page.evaluate(() => {
    document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }))
  })
  await new Promise((r) => setTimeout(r, 500))
  const idleLabel = await page.evaluate(() => document.querySelector('.dse-pill-text')?.textContent.trim() ?? null)
  report.step('药丸默认文案是「想吃大白饭」', idleLabel === '想吃大白饭', String(idleLabel))

  await openSection()
  const setTextField = async (labelText, value) => {
    await page.evaluate(({ label, v }) => {
      const field = [...document.querySelectorAll('.dse-cfg-field')]
        .find((f) => f.querySelector('.dse-cfg-field-label')?.textContent.trim() === label)
      if (!field) throw new Error(`no text field for ${label}`)
      const input = field.querySelector('input[type="text"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, { label: labelText, v: value })
    await new Promise((r) => setTimeout(r, 450))
  }
  const readTextConfig = () => page.evaluate(() => JSON.parse(
    window.localStorage.getItem('dsh-session-eater/config') || '{}').text)

  const textFields = await page.evaluate(() => [...document.querySelectorAll('.dse-cfg-field-label')]
    .map((el) => el.textContent.trim()))
  report.step('设置页里有全部文案输入框', textFields.length >= 12, `${textFields.length} 项: ${textFields.slice(0, 4).join('/')}…`)

  // 出厂默认应当就是用户要的那两条
  const defaults = await page.evaluate(() => JSON.parse(
    window.localStorage.getItem('dsh-session-eater/config') || '{}').text ?? null)
  console.log('默认文案:', JSON.stringify(defaults))
  report.step('出厂默认文案里 idle=想吃大白饭 / over=啊啊啊',
    defaults?.idle === '想吃大白饭' && defaults?.over === '啊啊啊', JSON.stringify(defaults))

  await setTextField('空闲时', '给我大白饭')
  const afterEdit = await page.evaluate(() => ({
    pill: document.querySelector('.dse-pill-text')?.textContent.trim() ?? null,
    stored: JSON.parse(window.localStorage.getItem('dsh-session-eater/config') || '{}').text?.idle ?? null
  }))
  report.step('改文案立刻生效', afterEdit.pill === '给我大白饭' && afterEdit.stored === '给我大白饭',
    JSON.stringify(afterEdit))

  // 留空 → 那段文字不显示（药丸只剩图标）
  await setTextField('空闲时', '')
  const blanked = await page.evaluate(() => ({
    hasTextNode: document.querySelector('.dse-pill-text') !== null,
    hasIcon: document.querySelector('.dse-pill-head img') !== null,
    flag: document.querySelector('.dse-pill')?.dataset.withText ?? null,
    marked: [...document.querySelectorAll('.dse-cfg-blank')].some((el) => el.textContent.includes('不显示'))
  }))
  report.step('文案留空后不再渲染那段文字，但图标还在',
    blanked.hasTextNode === false && blanked.hasIcon === true && blanked.flag === 'false' && blanked.marked,
    JSON.stringify(blanked))

  await setTextField('拖到鱼头上时', '啊啊啊我要开动了')
  const overText = await readTextConfig()
  report.step('可单独改「拖到鱼头上时」', overText.over === '啊啊啊我要开动了', String(overText.over))

  const resetText = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.dse-cfg-btn')].find((b) => b.textContent.includes('恢复默认文案'))
    btn?.click()
    return btn !== undefined
  })
  await new Promise((r) => setTimeout(r, 500))
  const afterTextReset = await page.evaluate(() => ({
    cfg: JSON.parse(window.localStorage.getItem('dsh-session-eater/config') || '{}').text,
    pill: document.querySelector('.dse-pill-text')?.textContent.trim() ?? null
  }))
  report.step('恢复默认文案', resetText && afterTextReset.cfg.idle === '想吃大白饭'
    && afterTextReset.cfg.over === '啊啊啊' && afterTextReset.cfg.dropHint === '拖到这里丢掉'
    && afterTextReset.pill === '想吃大白饭', JSON.stringify(afterTextReset.cfg))

  // 给 README 留一张「文案」区块的图
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll('.dse-cfg h3')].find((h) => h.textContent === '文案')
    heading?.scrollIntoView({ block: 'center' })
  })
  await new Promise((r) => setTimeout(r, 400))
  await page.screenshot({ path: fileURLToPath(new URL('../docs/settings-text.png', import.meta.url)) })

  // 「最近吃掉」是可持久撤销的地方，也留一张
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll('.dse-cfg h3')].find((h) => h.textContent === '最近吃掉')
    heading?.scrollIntoView({ block: 'center' })
  })
  await new Promise((r) => setTimeout(r, 400))
  await page.screenshot({ path: fileURLToPath(new URL('../docs/settings-eaten.png', import.meta.url)) })

  // ── 7. 恢复默认 ─────────────────────────────────────────────────────
  await page.evaluate(() => {
    document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }))
  })
  await openSection()
  const resetOk = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.dse-cfg-btn')].find((b) => b.textContent.includes('恢复全部默认'))
    btn?.click()
    return btn !== undefined
  })
  await new Promise((r) => setTimeout(r, 500))
  const afterReset = await page.evaluate((key) => {
    const cfg = JSON.parse(window.localStorage.getItem(key) || '{}')
    return { size: cfg.size, pillSize: cfg.pillSize, mode: cfg.image?.mode, mouth: cfg.mouth?.mode }
  }, CONFIG_KEY)
  report.step('恢复全部默认', resetOk && afterReset.size === 104 && afterReset.pillSize === 26
    && afterReset.mode === 'widget' && afterReset.mouth === 'auto', JSON.stringify(afterReset))

  // ── 8. 点侧栏药丸 → 直达本插件的设置分区 ────────────────────────────
  // 设置面板的开合是内核内部的 React state，没有对外 API，所以实现里点的是真 DOM
  // （设置触发器 → 导航项）。这条就是那段 DOM 逻辑的回归测试：内核升级把 aria-label
  // 或导航项文案改掉、或者 data-slot 契约变了，这里会立刻红。
  await page.keyboard.press('Escape') // 先关掉面板，测「关着 → 点药丸打开」这条路
  await new Promise((r) => setTimeout(r, 700))
  const closedFirst = await page.evaluate(() => document.querySelector('.dse-cfg') === null)
  const pillClicked = await page.evaluate(() => {
    const pill = document.querySelector('.dse-pill')
    if (pill === null) return false
    pill.click()
    return true
  })
  let landed = null
  for (let i = 0; i < 30 && landed === null; i += 1) {
    await new Promise((r) => setTimeout(r, 120))
    landed = await page.evaluate(() => {
      const dialog = document.querySelector("[role='dialog']")
      const nav = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '会话喂鱼' && b.offsetParent !== null)
      if (dialog === null || nav === undefined || nav === null) return null
      return {
        dialog: true,
        active: /active/i.test(String(nav.className)),
        sectionRendered: document.querySelector('.dse-cfg') !== null
      }
    })
    if (landed !== null && landed.sectionRendered) break
  }
  report.step('点侧栏药丸直达「设置 → 会话喂鱼」',
    closedFirst && pillClicked && landed !== null && landed.sectionRendered,
    JSON.stringify({ closedFirst, pillClicked, landed }))
} finally {
  await browser.close().catch(() => {})
}

process.exit(report.finish())
