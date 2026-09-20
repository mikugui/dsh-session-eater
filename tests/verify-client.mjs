/**
 * 客户端半边端到端测试（真实浏览器里的真实 DOM）。
 *
 * 安全性：页面里把 window.fetch 打了桩，`/dsh-session-eater/*` 请求只记账不外发，
 * 所以这个测试**不可能**删掉任何会话。拖拽用真实 DragEvent + DataTransfer 合成。
 *
 * 校验链路：药丸出现在 sidebar.footer.action → 拖会话行张开投放区 → 悬停到鱼头
 * 时嘴巴张开（chomp 动画在跑）→ 松手发出 POST /delete → 出现带「撤销」的回执。
 *
 * 运行：node tests/verify-client.mjs
 */
import { appUrl, browserExecutable, createReport, loadPuppeteer } from './lib.mjs'
import { fileURLToPath } from 'node:url'

const report = createReport()
const puppeteer = await loadPuppeteer()
const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: 'shell', args: ['--no-first-run'] })

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  // headless 默认 prefers-reduced-motion: reduce，会把我们自己的动画守卫打开；
  // 这里显式模拟"用户没关动画"，否则测不到咀嚼动画。
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
  await page.evaluateOnNewDocument(() => {
    window.__eaterCalls = []
    /** 造一个带会话 id 的拖拽载荷（合成拖拽用）。 */
    window.__dt = (sid) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', sid)
      return dt
    }
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.includes('/dsh-session-eater/')) {
        window.__eaterCalls.push({ url, method: (init && init.method) || 'GET', body: init && init.body })
        return Promise.resolve(new Response(
          JSON.stringify({ ok: true, sessionId: 'intercepted', moved: ['<intercepted>'] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ))
      }
      return original(input, init)
    }
  })

  await page.goto(appUrl(), { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 12000))

  report.step('client bundle is in __DSH_BOOT__',
    await page.evaluate(() => JSON.stringify(globalThis.__DSH_BOOT__ || {}).includes('dsh-session-eater')))

  // 诊断桥 + 会话列表快照（blank 标记决定了能不能喂）
  const probe = await page.evaluate(() => globalThis.__dshSessionEater?.sessionsProbe?.() ?? null)
  console.log('sessionsProbe:', JSON.stringify(probe))
  report.step('诊断桥可用', probe !== null && probe.hasService === true, JSON.stringify(probe?.snapshotKeys))
  const blankId = probe?.summaries?.find((s) => s.blank === true)?.id ?? null
  report.step('能从快照里认出空白会话', blankId === null || /^session-/.test(blankId), String(blankId))

  const shape = await page.evaluate(() => {
    const pill = document.querySelector('.dse-pill')
    const slot = document.querySelector("[data-slot='sidebar.footer.action']")
    return {
      pillText: pill ? pill.textContent.trim() : null,
      pillInSlot: slot ? slot.querySelector('.dse-pill') !== null : false,
      rows: document.querySelectorAll("[class*='sessionRow']").length
    }
  })
  report.step('eater pill renders inside sidebar.footer.action', shape.pillText !== null && shape.pillInSlot, shape.pillText || 'missing')
  report.step('session rows are present in the sidebar', shape.rows > 0, `${shape.rows} row(s)`)

  const SESSION = 'session-00000000-0000-0000-0000-000000000000'

  // 只挑**非空白**的会话行来合成拖拽（空白行会被插件按设计拒绝）
  await page.evaluate((sid) => {
    const rows = [...document.querySelectorAll("[class*='sessionRow']")]
    const row = rows.find((el) => !/selected/i.test(el.className) && el.querySelector("[class*='rowActions']"))
      ?? rows.find((el) => el.querySelector("[class*='rowActions']"))
    if (!row) throw new Error('no non-blank session row found')
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
  }, SESSION)
  await new Promise((r) => setTimeout(r, 400))

  const armed = await page.evaluate(() => {
    const plate = document.querySelector('.dse-plate')
    const pill = document.querySelector('.dse-pill')
    const b = plate ? plate.getBoundingClientRect() : null
    return {
      plate: plate !== null,
      rect: b ? [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] : null,
      phase: pill ? pill.dataset.phase : null,
      note: plate ? plate.textContent.trim() : null
    }
  })
  report.step('dragging a session row opens the drop plate', armed.plate === true, JSON.stringify(armed.rect))
  report.step('pill switches to the armed phase', armed.phase === 'armed', String(armed.phase))

  await page.evaluate((sid) => {
    const plate = document.querySelector('.dse-plate')
    const dt = window.__dt(sid)
    plate.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
    plate.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, SESSION)
  await new Promise((r) => setTimeout(r, 500))

  const hovered = await page.evaluate(() => {
    const pet = document.querySelector('.dse-pet')
    const mouth = document.querySelector('.dse-mouth')
    const plate = document.querySelector('.dse-plate')
    const cs = mouth ? getComputedStyle(mouth) : null
    return {
      plateAlive: plate !== null,
      petOver: pet ? pet.dataset.over : null,
      plateOver: plate ? plate.dataset.over : null,
      note: plate ? plate.textContent.trim() : null,
      opacity: cs ? cs.opacity : null,
      animation: cs ? cs.animationName : null,
      borderStyle: plate ? getComputedStyle(plate).borderStyle : null
    }
  })
  report.step('drop plate survives being hovered', hovered.plateAlive === true)
  report.step('mouth opens while hovering the fish', hovered.petOver === 'true' && Number(hovered.opacity) > 0.5, `opacity=${hovered.opacity}`)
  report.step('mouth runs the chew animation', String(hovered.animation).includes('dse-chew'), String(hovered.animation))
  report.step('plate highlights as a live drop target',
    hovered.plateOver === 'true' && hovered.borderStyle === 'solid' && hovered.note.includes('啊啊啊'),
    `${hovered.plateOver}/${hovered.borderStyle}/${hovered.note}`)

  await page.evaluate((sid) => {
    const plate = document.querySelector('.dse-plate')
    plate.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
  }, SESSION)
  await new Promise((r) => setTimeout(r, 1200))

  const after = await page.evaluate(() => {
    const toast = document.querySelector('.dse-toast')
    const undo = toast?.querySelector('button[data-role="undo"]')
    const rect = undo ? undo.getBoundingClientRect() : null
    return {
      calls: window.__eaterCalls,
      toast: toast ? toast.textContent.trim() : null,
      kind: toast ? toast.dataset.kind : null,
      undo: undo !== null && undo !== undefined,
      undoLabel: undo ? undo.textContent.trim() : null,
      undoRect: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null,
      insideViewport: rect !== null
        && rect.width > 20 && rect.height > 10
        && rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      ledger: globalThis.__dshSessionEater?.lastEaten?.() ?? null
    }
  })
  report.step('drop issues POST /dsh-session-eater/delete',
    after.calls.some((c) => c.url.includes('/delete') && c.method === 'POST'), JSON.stringify(after.calls))
  report.step('success toast offers the 撤销 undo action',
    after.toast !== null && after.undo && after.kind === 'ok', after.toast || 'none')
  report.step('撤销按钮真的可见（有尺寸、在视口内）',
    after.insideViewport === true, `label=${after.undoLabel} rect=${JSON.stringify(after.undoRect)}`)
  report.step('吃掉后写进「最近吃掉」台账',
    Array.isArray(after.ledger) && after.ledger.some((e) => e.sessionId === SESSION),
    JSON.stringify(after.ledger))

  // 撤销回执是持久浮层：等 5 秒后它必须还在（不会被自动收走）
  await new Promise((r) => setTimeout(r, 5000))
  const stillThere = await page.evaluate(() => ({
    toast: document.querySelector('.dse-toast') !== null,
    undo: document.querySelector('.dse-toast button[data-role="undo"]') !== null
  }))
  report.step('带撤销的回执不会自动消失（5 秒后仍在）',
    stillThere.toast && stillThere.undo, JSON.stringify(stillThere))
  await page.screenshot({ path: fileURLToPath(new URL('../docs/toast-undo.png', import.meta.url)) })

  // ── 侧边栏药丸行右侧的撤销按钮 ──────────────────────────────────────
  const bar = await page.evaluate(() => {
    const foot = document.querySelector('.dse-foot')
    const head = document.querySelector('.dse-pill-head')
    const undo = document.querySelector('.dse-undo')
    if (!foot || !head || !undo) return { missing: true, foot: foot !== null, head: head !== null, undo: undo !== null }
    const f = foot.getBoundingClientRect()
    const h = head.getBoundingClientRect()
    const u = undo.getBoundingClientRect()
    const centerY = (r) => Math.round(r.top + r.height / 2)
    return {
      label: undo.textContent.trim(),
      title: undo.getAttribute('title'),
      sameRow: Math.abs(centerY(h) - centerY(u)) <= 2,
      rightAligned: f.right - u.right <= 2,
      toTheRightOfIcon: u.left > h.left,
      insideViewport: u.left >= 0 && u.right <= window.innerWidth,
      rect: [Math.round(u.x), Math.round(u.y), Math.round(u.width), Math.round(u.height)],
      iconRect: [Math.round(h.x), Math.round(h.y), Math.round(h.width), Math.round(h.height)]
    }
  })
  console.log('sidebar undo bar:', JSON.stringify(bar))
  report.step('药丸行右侧出现撤销按钮', bar.missing !== true, JSON.stringify(bar.rect))
  report.step('与图标同一行（垂直居中对齐）', bar.sameRow === true,
    `icon=${JSON.stringify(bar.iconRect)} undo=${JSON.stringify(bar.rect)}`)
  report.step('贴在药丸行最右侧且在视口内', bar.rightAligned === true && bar.insideViewport === true)
  report.step('按钮文案用「撤销按钮」那段自定义文案', bar.label === '撤销', String(bar.label))

  // 点它必须真的调 /restore（fetch 已打桩，不会碰真数据）。
  // 注意：撤销成功后插件会 location.reload()，那会把 window.__eaterCalls 清掉，
  // 所以必须在刷新之前把调用抓下来。
  await page.click('.dse-undo')
  const restoreCall = await page.evaluate(async () => {
    const deadline = Date.now() + 600
    while (Date.now() < deadline) {
      if (window.__eaterCalls.some((c) => c.url.includes('/restore'))) break
      await new Promise((r) => setTimeout(r, 40))
    }
    return window.__eaterCalls.slice(-3)
  })
  console.log('restore calls:', JSON.stringify(restoreCall))
  report.step('点侧边栏撤销会调 /dsh-session-eater/restore',
    restoreCall.some((c) => c.url.includes('/restore') && c.method === 'POST'),
    JSON.stringify(restoreCall))

  // ── 空白会话必须被拒绝 ──────────────────────────────────────────────
  // 这正是用户报的"删了刷新又回来"：DSH 会为工作区再建一个空白「新会话」，
  // 所以插件改成拒绝，并说明原因，而不是假装删掉了。
  if (blankId !== null) {
    await new Promise((r) => setTimeout(r, 4400)) // 等上一条回执自己消失，避免读到旧文案
    await page.evaluate((sid) => {
      window.__eaterCalls.length = 0
      const row = [...document.querySelectorAll("[class*='sessionRow']")]
        .find((el) => !el.querySelector("[class*='rowActions']"))
      if (!row) throw new Error('no blank session row in the sidebar')
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
    }, blankId)
    await new Promise((r) => setTimeout(r, 450))
    const armedForBlank = await page.evaluate(() => document.querySelector('.dse-plate') !== null)
    await page.evaluate((sid) => {
      const plate = document.querySelector('.dse-plate')
      plate.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
    }, blankId)
    await new Promise((r) => setTimeout(r, 900))
    const blankResult = await page.evaluate(() => ({
      calls: window.__eaterCalls,
      toast: document.querySelector('.dse-toast')?.textContent.trim() ?? null
    }))
    console.log('blank drop:', JSON.stringify(blankResult))
    report.step('拖空白会话也能武装投放区', armedForBlank)
    report.step('空白会话被拒绝、且没有发出删除请求', blankResult.calls.length === 0,
      `calls=${blankResult.calls.length}`)
    report.step('空白会话给出解释', String(blankResult.toast || '').includes('空白会话'),
      String(blankResult.toast))
  } else {
    console.log('SKIP  当前没有空白会话可测')
  }

  // ── 台账里的会话必须从「单列表」视图里消失 ──────────────────────────
  // 这条曾经是真 bug：删掉后宿主进程里那个会话对象还活着，新页面拉 baseline 又把它塞回
  // 客户端快照；「按工作区」视图靠账目过滤所以看不出来，但切到「单列表」就整排冒回来。
  const setView = async (label) => {
    await page.click("button[aria-label='视图选项']")
    await new Promise((r) => setTimeout(r, 600))
    await page.evaluate((text) => {
      const item = [...document.querySelectorAll("[role='menuitem']")]
        .find((el) => (el.textContent || '').trim() === text)
      item?.click()
    }, label)
    await new Promise((r) => setTimeout(r, 800))
  }
  const rowTitles = () => page.evaluate(() => [...document.querySelectorAll("[class*='sessionRow']")]
    .map((el) => (el.textContent || '').trim()))

  await page.evaluate(() => window.localStorage.removeItem('dsh-session-eater/eaten'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 12000))
  await setView('单列表')
  const flatBefore = await rowTitles()
  const victim = await page.evaluate(() => {
    const probe = globalThis.__dshSessionEater.sessionsProbe()
    return (probe.summaries ?? []).find((s) => s.id !== probe.current && s.blank !== true && s.title) ?? null
  })
  if (victim === null) {
    console.log('SKIP  没有可隐藏的非当前会话')
  } else {
    await page.evaluate((entry) => {
      window.localStorage.setItem('dsh-session-eater/eaten', JSON.stringify([entry]))
    }, { sessionId: victim.id, title: victim.title, at: Date.now() })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await new Promise((r) => setTimeout(r, 12000))
    await setView('单列表')
    const flatAfter = await rowTitles()
    const key = String(victim.title).slice(0, 8)
    report.step('台账里的会话会从「单列表」视图消失',
      !flatAfter.some((title) => title.includes(key)) && flatBefore.some((title) => title.includes(key)),
      `「${victim.title}」 ${flatBefore.length} → ${flatAfter.length} 行`)
    await page.evaluate(() => window.localStorage.removeItem('dsh-session-eater/eaten'))
  }
} finally {
  await browser.close().catch(() => {})
}

process.exit(report.finish())
