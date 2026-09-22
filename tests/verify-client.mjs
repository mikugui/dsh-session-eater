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
    // 需要时把 /delete 变成"宿主拒绝"（模拟 409 session-running：会话正在跑）
    window.__refuseDelete = false
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.includes('/dsh-session-eater/')) {
        window.__eaterCalls.push({ url, method: (init && init.method) || 'GET', body: init && init.body })
        if (window.__refuseDelete === true && url.includes('/delete')) {
          return Promise.resolve(new Response(
            JSON.stringify({ ok: false, code: 'session-running', error: '该会话正在运行，先停止它再喂鱼' }),
            { status: 409, headers: { 'content-type': 'application/json' } }
          ))
        }
        // /usage 要回一份"像真的"的用量：确认弹窗会把 total 格式化成 1.2M 写进询问语，
        // 元信息行再拼上轮数和缓存命中占比。写死一份，断言才有确定值可比。
        const payload = url.includes('/usage')
          ? {
            ok: true,
            sessionId: 'intercepted',
            total: 1234567,
            uncachedInputTokens: 20000,
            outputTokens: 14567,
            cacheReadTokens: 1200000,
            cacheWriteTokens: 0,
            turns: 42,
            steps: 100
          }
          : { ok: true, sessionId: 'intercepted', moved: ['<intercepted>'] }
        return Promise.resolve(new Response(
          JSON.stringify(payload),
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

  // ── 拖上去先弹确认（默认开）────────────────────────────────────────
  // 以前是松手即删；现在停在会话列表里问一句，点了「删除」才真吃。
  const armAndDrop = async () => {
    await page.evaluate((sid) => {
      const rows = [...document.querySelectorAll("[class*='sessionRow']")]
      const row = rows.find((el) => !/selected/i.test(el.className) && el.querySelector("[class*='rowActions']"))
        ?? rows.find((el) => el.querySelector("[class*='rowActions']"))
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
    }, SESSION)
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate((sid) => {
      const plate = document.querySelector('.dse-plate')
      const dt = window.__dt(sid)
      plate.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
      plate.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, SESSION)
    await new Promise((r) => setTimeout(r, 400))
    await page.evaluate((sid) => {
      const plate = document.querySelector('.dse-plate')
      plate.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
    }, SESSION)
    await new Promise((r) => setTimeout(r, 500))
  }

  await page.evaluate((sid) => {
    const plate = document.querySelector('.dse-plate')
    plate.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
  }, SESSION)
  await new Promise((r) => setTimeout(r, 500))

  const dialog = await page.evaluate(() => {
    const box = document.querySelector('.dse-confirm')
    const plate = document.querySelector('.dse-plate')
    const slot = document.querySelector("[data-slot='sidebar.workspaces']")
    const r = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]
    }
    const d = r(box)
    const p = r(plate)
    const s = r(slot)
    return {
      exists: box !== null,
      ask: box ? box.querySelector('.dse-confirm-ask')?.textContent.trim() : null,
      text: box ? box.textContent.trim() : null,
      parts: box ? [...box.children].map((el) => String(el.className)) : [],
      eager: document.querySelector('.dse-pet')?.dataset.eager ?? null,
      mouthOpacity: (() => {
        const m = document.querySelector('.dse-plate .dse-mouth')
        return m ? getComputedStyle(m).opacity : null
      })(),
      mouthAnimation: (() => {
        const m = document.querySelector('.dse-plate .dse-mouth')
        return m ? getComputedStyle(m).animationName : null
      })(),
      yes: box ? box.querySelector('[data-role="confirm-ok"]')?.textContent.trim() : null,
      no: box ? box.querySelector('[data-role="confirm-cancel"]')?.textContent.trim() : null,
      focused: document.activeElement ? document.activeElement.getAttribute('data-role') : null,
      // 只数删除类请求：插件启动时会主动探一次 /status（客户端读不到 package.json），
      // 那是正常的探测，不该算进"有没有发删除请求"
      calls: window.__eaterCalls.filter((c) => /\/(delete|restore)$/.test(c.url)).length,
      allCalls: window.__eaterCalls.map((c) => c.url),
      rects: { dialog: d, plate: p, slot: s },
      // 弹窗要落在投放区里，而投放区贴在会话列表下缘（左侧那一列）
      insidePlate: d !== null && p !== null && d[0] >= p[0] - 2 && d[2] <= p[2] + 2
        && d[1] >= p[1] - 2 && d[3] <= p[3] + 2,
      // 注意别用 [data-slot='sidebar.workspaces'] 量位置：那层壳的 rect 是 0×0
      // （display:contents），拿它比会永远失败 —— 用视口左半边判定
      plateInLeftColumn: p !== null && p[0] >= 0 && p[2] <= window.innerWidth * 0.45
    }
  })
  console.log('confirm dialog:', JSON.stringify(dialog))
  report.step('拖上去先弹确认、且此刻不发任何删除请求',
    dialog.exists === true && dialog.calls === 0, JSON.stringify(dialog))
  report.step('确认框落在投放区里（即左侧会话列表内）',
    dialog.insidePlate === true && dialog.plateInLeftColumn === true, JSON.stringify(dialog.rects))
  report.step('确认框只问一句 + 两个按钮',
    String(dialog.ask || '').includes('真的给我吃吗')
    && dialog.yes === '删除' && dialog.no === '取消', JSON.stringify(dialog))
  // 询问语里的 token 数：桩返回 total=1234567 → 应写成「1.2M」
  report.step('询问语里写出了这个会话消耗的 token 数',
    String(dialog.ask || '').includes('1.2M token'), String(dialog.ask))
  // 弹窗要够小：正文只有"询问语"和"按钮行"两个子元素 —— 会话名/轮数/命中率都不该再出现
  report.step('弹窗里没有会话名、轮数、缓存命中率',
    dialog.parts.length === 2 && dialog.parts[0] === 'dse-confirm-ask'
    && !/session-|轮|缓存命中/.test(dialog.text ?? ''),
    JSON.stringify({ parts: dialog.parts, text: dialog.text }))
  // 确认期间鱼要是"张嘴渴望"：嘴张着（opacity 1）且**不在咀嚼**（animationName 为 none），
  // 跟悬停时那种 dse-chew 明确区分开。
  report.step('确认期间大肥鱼张嘴渴望（嘴不动、不是咀嚼）',
    dialog.eager === 'true' && Number(dialog.mouthOpacity) > 0.5 && dialog.mouthAnimation === 'none',
    JSON.stringify({ eager: dialog.eager, opacity: dialog.mouthOpacity, animation: dialog.mouthAnimation }))
  report.step('默认焦点在「取消」上（回车不该误删）', dialog.focused === 'confirm-cancel', String(dialog.focused))
  await page.screenshot({ path: fileURLToPath(new URL('../docs/confirm.png', import.meta.url)) })

  // 取消这条路：收起来，一个请求都不许发
  await page.click('[data-role="confirm-cancel"]')
  await new Promise((r) => setTimeout(r, 400))
  const cancelled = await page.evaluate(() => ({
    dialog: document.querySelector('.dse-confirm') !== null,
    plate: document.querySelector('.dse-plate') !== null,
    calls: window.__eaterCalls.filter((c) => /\/(delete|restore)$/.test(c.url)).length
  }))
  report.step('点「取消」：收起确认框且一个请求都不发',
    cancelled.dialog === false && cancelled.plate === false && cancelled.calls === 0, JSON.stringify(cancelled))

  // 确定这条路：这次才真删
  await armAndDrop()
  const confirmed = await page.evaluate(() => ({
    dialog: document.querySelector('.dse-confirm') !== null,
    ok: document.querySelector('[data-role="confirm-ok"]') !== null
  }))
  await page.click('[data-role="confirm-ok"]')
  await new Promise((r) => setTimeout(r, 1400))

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
  report.step('点「删除」才发 POST /dsh-session-eater/delete',
    confirmed.dialog && confirmed.ok && after.calls.some((c) => c.url.includes('/delete') && c.method === 'POST'),
    JSON.stringify(after.calls))
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

  // 关掉「删除前确认」→ 回到"松手即删"的老行为（设置里那个开关就是干这个的）
  await page.evaluate(() => { globalThis.__dshSessionEater.setConfig({ confirm: { enabled: false } }) })
  await new Promise((r) => setTimeout(r, 300))
  const callsBefore = await page.evaluate(() => window.__eaterCalls.length)
  await armAndDrop()
  const withoutConfirm = await page.evaluate((before) => ({
    dialog: document.querySelector('.dse-confirm') !== null,
    grew: window.__eaterCalls.length > before,
    stored: JSON.parse(window.localStorage.getItem('dsh-session-eater/config') || '{}')?.confirm?.enabled
  }), callsBefore)
  report.step('关掉开关后：松手立即删除、不再弹确认',
    withoutConfirm.dialog === false && withoutConfirm.grew === true && withoutConfirm.stored === false,
    JSON.stringify(withoutConfirm))
  // 还原，别把配置留在"关"的状态影响后面的用例
  await page.evaluate(() => { globalThis.__dshSessionEater.setConfig({ confirm: { enabled: true } }) })

  // ── 样式自愈：样式被摘掉后不刷新也能自己回来 ────────────────────────
  // 背景：客户端半边热重载时，apply 的清理函数会摘掉我们注入的 <style>；若那次重载
  // 失败，页面就一直裸奔。实测过别人的插件栽在这（表情包面板从 4 列网格退化成一列竖排）。
  const cssHeal = await page.evaluate(async () => {
    const sel = 'style[data-plugin-css="dsh-session-eater/client.css"]'
    const pill = document.querySelector('.dse-pill')
    const before = {
      style: document.querySelector(sel) !== null,
      radius: pill ? getComputedStyle(pill).borderTopLeftRadius : null
    }
    document.querySelector(sel)?.remove()
    const stripped = {
      style: document.querySelector(sel) !== null,
      radius: pill ? getComputedStyle(pill).borderTopLeftRadius : null
    }
    await new Promise((r) => setTimeout(r, 400))
    const healed = document.querySelector(sel) !== null
    return { before, stripped, healed, radius: pill ? getComputedStyle(pill).borderTopLeftRadius : null }
  })
  console.log('css self-heal:', JSON.stringify(cssHeal))
  report.step('样式被摘掉后能自愈（不用刷新）',
    cssHeal.before.style === true && cssHeal.stripped.style === false
    && cssHeal.stripped.radius === '0px' && cssHeal.healed === true && cssHeal.radius === cssHeal.before.radius,
    JSON.stringify(cssHeal))

  // ── 侧边栏撤销按钮：必须**不存在** ──────────────────────────────────
  // 它读的是 localStorage 台账，而台账本来就要跨刷新保留 —— 于是刷新/重启后那个
  // 按钮一直挂在那儿，用户看到的就是"删不掉的撤销按钮"。现在撤掉它：
  // 撤销只走回执（内存态，刷新即消失）和设置里的 12 条台账。
  const bar = await page.evaluate(() => {
    const foot = document.querySelector('.dse-foot')
    const pill = document.querySelector('.dse-pill')
    return {
      hasUndo: document.querySelector('.dse-undo') !== null
        || document.querySelector('[data-role="sidebar-undo"]') !== null,
      hasFoot: foot !== null,
      hasPill: pill !== null,
      children: foot ? foot.children.length : -1,
      ledgerSize: (globalThis.__dshSessionEater?.lastEaten?.() ?? []).length
    }
  })
  console.log('sidebar foot:', JSON.stringify(bar))
  report.step('台账里有记录时，侧边栏也不再有撤销按钮',
    bar.hasUndo === false && bar.hasFoot && bar.hasPill && bar.ledgerSize > 0,
    JSON.stringify(bar))
  report.step('药丸行只剩药丸一个子元素', bar.children === 1, String(bar.children))

  // 回执上的撤销仍然必须真的调 /restore（fetch 已打桩，不会碰真数据）。
  // 注意：撤销成功后插件会 location.reload()，那会把 window.__eaterCalls 清掉，
  // 所以必须在刷新之前把调用抓下来。
  await page.click('.dse-toast button[data-role="undo"]')
  const restoreCall = await page.evaluate(async () => {
    const deadline = Date.now() + 600
    while (Date.now() < deadline) {
      if (window.__eaterCalls.some((c) => c.url.includes('/restore'))) break
      await new Promise((r) => setTimeout(r, 40))
    }
    return window.__eaterCalls.slice(-3)
  })
  console.log('restore calls:', JSON.stringify(restoreCall))
  report.step('点回执里的撤销会调 /dsh-session-eater/restore',
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
      toast: document.querySelector('.dse-toast')?.textContent.trim() ?? null,
      blocked: document.querySelector('.dse-plate')?.dataset.blocked ?? null,
      note: document.querySelector('.dse-plate-note')?.textContent.trim() ?? null,
      plateRed: (() => {
        const p = document.querySelector('.dse-plate')
        if (p === null) return null
        return getComputedStyle(p).borderTopColor === 'rgb(229, 72, 77)'
      })(),
      mouthOpacity: (() => {
        const m = document.querySelector('.dse-plate .dse-mouth')
        return m ? getComputedStyle(m).opacity : null
      })()
    }))
    console.log('blank drop:', JSON.stringify(blankResult))
    report.step('拖空白会话也能武装投放区', armedForBlank)
    report.step('空白会话被拒绝、且没有发出删除请求', blankResult.calls.length === 0,
      `calls=${blankResult.calls.length}`)
    report.step('空白会话给出解释', String(blankResult.toast || '').includes('空白会话'),
      String(blankResult.toast))
    report.step('拒绝时投放区变红并写出原因（不只靠底部 toast）',
      blankResult.blocked === 'true' && String(blankResult.note || '').includes('空白会话')
      && blankResult.plateRed === true, JSON.stringify(blankResult))
    report.step('拒绝时鱼闭着嘴（不摆出要吃的张嘴样子）',
      blankResult.mouthOpacity === '0', String(blankResult.mouthOpacity))
  } else {
    console.log('SKIP  当前没有空白会话可测')
  }

  // ── 拖「正在聊的这个会话」：必须就地拒绝、不能只是静默 ────────────────
  // 用户报的现象：把正打开的对话拖到鱼身上，鱼吃不掉，而且只有屏幕底部一条 6 秒 toast
  // （眼睛盯着左上角的鱼，很容易漏掉，看着就像"点了没反应"）。
  // 测试浏览器默认开着一个空白「新会话」，而"正在聊的那个"必须是非空白会话才测得到 ——
  // 先点开一条有内容的会话，让它成为 current。
  const opened = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll("[class*='sessionRow']")]
    const row = rows.find((el) => el.querySelector("[class*='rowActions']"))
    if (!row) return { ok: false, reason: 'no non-blank row' }
    row.click()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const cur = globalThis.__dshSessionEater.current()
      if (cur !== '' && globalThis.__dshSessionEater.isBlank(cur) !== true) return { ok: true, current: cur }
      await new Promise((r) => setTimeout(r, 300))
    }
    return { ok: false, reason: 'current 没变成非空白会话', current: globalThis.__dshSessionEater.current() }
  })
  console.log('opened session:', JSON.stringify(opened))
  const currentId = opened.ok === true ? opened.current : await page.evaluate(() => globalThis.__dshSessionEater.current())
  const currentBlank = opened.ok === true ? false
    : await page.evaluate((sid) => globalThis.__dshSessionEater.isBlank(sid), currentId)
  if (currentId === '' || currentBlank === true) {
    console.log(`SKIP  拿不到非空白的当前会话（${currentId || 'none'}），"正在聊的那个"这条用例跳过`)
  } else {
    await page.evaluate((sid) => {
      window.__eaterCalls.length = 0
      const rows = [...document.querySelectorAll("[class*='sessionRow']")]
      const row = rows.find((el) => el.querySelector("[class*='rowActions']")) ?? rows[0]
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
    }, currentId)
    await new Promise((r) => setTimeout(r, 400))
    // 悬停在鱼头上：这时就该有醒目反馈（而不是等松手）
    await page.evaluate((sid) => {
      const plate = document.querySelector('.dse-plate')
      const dt = window.__dt(sid)
      plate.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
      plate.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, currentId)
    await new Promise((r) => setTimeout(r, 400))
    const hoverRefuse = await page.evaluate(() => ({
      blocked: document.querySelector('.dse-plate')?.dataset.blocked ?? null,
      note: document.querySelector('.dse-plate-note')?.textContent.trim() ?? null,
      mouthOpacity: (() => {
        const m = document.querySelector('.dse-plate .dse-mouth')
        return m ? getComputedStyle(m).opacity : null
      })()
    }))
    console.log('hover refuse:', JSON.stringify(hoverRefuse))
    report.step('悬停就提示"不能吃"：投放区变红 + 写出原因',
      hoverRefuse.blocked === 'true' && String(hoverRefuse.note || '').includes('正在聊'),
      JSON.stringify(hoverRefuse))
    report.step('悬停时就闭嘴（不装出要吃的样子）', hoverRefuse.mouthOpacity === '0', String(hoverRefuse.mouthOpacity))

    // 松手：阶段停在 refused（晃两下）、不发删除请求、底部仍补一条 toast
    await page.evaluate((sid) => {
      const plate = document.querySelector('.dse-plate')
      plate.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt(sid) }))
    }, currentId)
    await new Promise((r) => setTimeout(r, 400))
    const refused = await page.evaluate(() => ({
      phase: document.querySelector('.dse-plate')?.dataset.phase ?? null,
      blocked: document.querySelector('.dse-plate')?.dataset.blocked ?? null,
      note: document.querySelector('.dse-plate-note')?.textContent.trim() ?? null,
      toast: document.querySelector('.dse-toast')?.textContent.trim() ?? null,
      calls: window.__eaterCalls.filter((c) => /\/(delete|restore)$/.test(c.url)).length
    }))
    console.log('current drop refused:', JSON.stringify(refused))
    report.step('松手被拒：停在 refused 阶段并写清原因、且不发删除请求',
      refused.phase === 'refused' && refused.blocked === 'true'
      && String(refused.note || '').includes('正在聊') && refused.calls === 0,
      JSON.stringify(refused))
    report.step('被拒时底部也补一条 toast（双通道）',
      String(refused.toast || '').includes('正在聊'), String(refused.toast))
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
  // ── 宿主说"这条还在跑"（409 session-running）：也要走就地拒绝 ──────────
  // 以前它走的是普通失败回执（"没吃下去：该会话正在运行…"）—— 单看像是插件坏了；
  // 其实它和"空白会话 / 正在聊的这个"一样都是"不能吃"，反馈风格应当一致：
  // 投放区变红 + 写清原因 + 松手摇头，而不是当错误报。
  // 放在最后：这一条会顶掉前面那枚带撤销的持久回执，不适合插在中间。
  const runningVictim = await page.evaluate(() => {
    const probe = globalThis.__dshSessionEater?.sessionsProbe?.()
    const found = (probe?.summaries ?? []).find((s) => s.id !== probe.current && s.blank !== true)
    return found ? found.id : null
  })
  if (runningVictim === null) {
    console.log('SKIP  没有可用于 409 用例的非当前会话')
  } else {
    await page.evaluate(() => { window.__refuseDelete = true })
    const dragTo = async (sid) => {
      await page.evaluate((id) => {
        const rows = [...document.querySelectorAll("[class*='sessionRow']")]
        const row = rows.find((el) => !/selected/i.test(el.className) && el.querySelector("[class*='rowActions']"))
          ?? rows[0]
        row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt(id) }))
      }, sid)
      await new Promise((r) => setTimeout(r, 350))
      await page.evaluate((id) => {
        const plate = document.querySelector('.dse-plate')
        const dt = window.__dt(id)
        plate.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
        plate.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      }, sid)
      await new Promise((r) => setTimeout(r, 400))
      await page.evaluate((id) => {
        const plate = document.querySelector('.dse-plate')
        plate.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt(id) }))
      }, sid)
      await new Promise((r) => setTimeout(r, 600))
    }
    const callsBeforeRefuse = await page.evaluate(() => window.__eaterCalls.length)
    await dragTo(runningVictim)
    // 确认框应该照常弹（这条会话本身是可吃的），点了「删除」才轮到宿主回 409
    const askedFirst = await page.evaluate(() => document.querySelector('[data-role="confirm-ok"]') !== null)
    report.step('409 用例前置：这条会话先正常弹确认框', askedFirst === true, String(askedFirst))
    await page.click('[data-role="confirm-ok"]')
    await new Promise((r) => setTimeout(r, 900))
    const running = await page.evaluate((before) => ({
      phase: document.querySelector('.dse-plate')?.dataset.phase ?? null,
      blocked: document.querySelector('.dse-plate')?.dataset.blocked ?? null,
      note: document.querySelector('.dse-plate-note')?.textContent.trim() ?? null,
      toast: document.querySelector('.dse-toast')?.textContent.trim() ?? null,
      sentDelete: window.__eaterCalls.slice(before).some((c) => c.url.includes('/delete')),
      mouthOpacity: (() => {
        const m = document.querySelector('.dse-plate .dse-mouth')
        return m ? getComputedStyle(m).opacity : null
      })()
    }), callsBeforeRefuse)
    console.log('running refusal:', JSON.stringify(running))
    report.step('宿主 409（会话还在跑）：也走就地拒绝、写清原因',
      running.sentDelete === true && running.phase === 'refused' && running.blocked === 'true'
      && String(running.note || '').includes('还在跑') && running.mouthOpacity === '0',
      JSON.stringify(running))
    report.step('409 不混进"没吃下去"那类失败回执',
      String(running.toast || '').includes('还在跑') && !String(running.toast || '').includes('没吃下去'),
      String(running.toast))

    // 归位：1.8 秒后自己回到 idle（顺带验证 setTimeout 里读到的是活 state，不是闭包快照）
    await new Promise((r) => setTimeout(r, 2200))
    const settled = await page.evaluate(() => ({
      plate: document.querySelector('.dse-plate') !== null,
      phase: document.querySelector('.dse-plate')?.dataset.phase ?? null
    }))
    report.step('被拒 1.8 秒后自己归位（投放区收起）',
      settled.plate === false || settled.phase === 'idle', JSON.stringify(settled))
    await page.evaluate(() => { window.__refuseDelete = false })
  }

} finally {
  await browser.close().catch(() => {})
}

process.exit(report.finish())
