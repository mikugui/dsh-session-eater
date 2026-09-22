/**
 * dsh-session-eater — 客户端半边（DSH Web 界面）。
 *
 * 把「余额小胖鱼挂件」的形象搬到左侧会话列表的下缘，当作一只垃圾桶：
 *   · 平时是一枚安静的「喂鱼」药丸（注册在 sidebar.footer.action 席位）；
 *   · 一旦你开始拖拽某个会话行，它会在会话列表底部张开一块大投放区；
 *   · 把它拖到鱼头上 → 张嘴啃（嘴部开合动画 + 身体挤压）；
 *   · 松手 → POST /dsh-session-eater/delete，会话被「吃掉」（宿主侧移入回收站），
 *     列表里那一行随之消失，并给出一条可撤销的回执。
 *
 * 另外在「设置 → 会话喂鱼」里给了一个配置页：可以换成自己的图标、拖拽校准嘴的位置、
 * 调形象尺寸与咀嚼快慢。配置存在 localStorage（本浏览器生效，改完立刻生效，不用重启）。
 *
 * 会话行由 @deepseek-ai/dsh-client-ui-workspace 渲染，已经带 draggable 与
 * `dataTransfer.setData("text/plain", sessionId)`，所以这里只需要在文档级监听
 * 拖拽事件 + 在投放区上开一个 drop 口即可，不碰官方组件。
 */
window.__ModuleLoader__.load({
	id: "dsh-session-eater",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		const { useCallback, useEffect, useRef, useState } = react;

		const NS = "dsh-session-eater";
		/** 宿主半边提供的路由前缀。 */
		const API = "/dsh-session-eater";
		/** 余额挂件的形象（挂件 0.3.x 的默认角色图，换角色后这里跟着变）。 */
		const IMAGE_PRIMARY = "/dsh-whale/image.png";
		/** 挂件不在场时的兜底形象（本插件自带）。 */
		const IMAGE_FALLBACK = API + "/whale.png";

		/** 设置页在导航里的名字。刻意**不**放进可自定义文案 —— 否则把它清空就再也找不到这个设置页了。 */
		const NAV_LABEL = "会话喂鱼";

		/**
		 * 所有可自定义界面文案的出厂值。
		 *
		 * 每一项都能在「设置 → 会话喂鱼 → 文案」里改写；**留空 = 那段文字不显示**
		 * （药丸只剩图标、投放区只剩鱼、回执只剩会话标题）。
		 */
		const DEFAULT_TEXT = {
			hint: "把不要的会话拖到鱼头上，它会替你吃掉（删除）",
			idle: "想吃大白饭",
			armed: "松手喂鱼",
			over: "啊啊啊",
			eating: "咔嚓…",
			eaten: "嗝～已吃掉",
			dropHint: "拖到这里丢掉",
			restore: "撤销",
			restored: "已吐出来，刷新后回到列表",
			failed: "没吃下去",
			self: "别喂正在聊的这个会话",
			blank: "空白会话不用清理 —— DSH 需要时会立刻再建一个「新会话」",
			confirmAsk: "你确定要吃掉这个会话吗？",
			confirmAskTokens: "你确定要吃掉这个消耗了 {tokens} token 的会话吗？",
			confirmYes: "删除",
			confirmNo: "取消"
		};

		/** 设置页里每一行文案的标签与说明。 */
		const TEXT_FIELDS = [
			["idle", "空闲时", "药丸上的字（平时显示的那个）"],
			["armed", "开始拖拽时", "已经抓起会话、还没到鱼头上"],
			["over", "拖到鱼头上时", "同时也是投放区的提示语"],
			["eating", "正在吃时", "松手之后、请求返回之前"],
			["dropHint", "投放区提示", "还没拖到鱼上时，投放区里的那行字"],
			["eaten", "吃完回执", "后面会自动接上会话标题"],
			["failed", "失败回执", "后面会自动接上错误信息"],
			["restore", "回执上的撤销", "回执里那个撤销按钮的字；留空则回执上不显示撤销"],
			["restored", "撤销成功提示", "点完撤销之后的回执"],
			["self", "拒绝：正在聊的会话", "拖的正是当前打开的会话时的提示"],
			["blank", "拒绝：空白会话", "拖的是没有内容的「新会话」时的提示"],
			["hint", "悬浮说明", "鼠标停在药丸上时的小提示（title）"],
			["confirmAsk", "确认弹窗标题", "读不到 token 用量时用这条（下面会列出会话名）"],
			["confirmAskTokens", "确认弹窗标题（带用量）", "里面的 {tokens} 会被换成实际用量；留空或读不到用量时退回上面那条"],
			["confirmYes", "确认弹窗：确定", "真的删掉那个按钮"],
			["confirmNo", "确认弹窗：取消", "算了、不发任何请求那个按钮"]
		];

		// ══════════════════════════════════════════════════════════════════
		// 配置：模块级小 store，localStorage 持久化，任何一处改动全体重渲染
		// ══════════════════════════════════════════════════════════════════
		const CONFIG_KEY = "dsh-session-eater/config";
		/** 默认配置。嘴的坐标来自对 610×610 原始立绘的实测。 */
		const DEFAULT_CONFIG = {
			v: 1,
			/** image.mode: "widget" = 跟随余额挂件；"custom" = 用 custom（dataURL 或 http(s) URL）。 */
			image: { mode: "widget", custom: "" },
			/** 投放区形象边长（px）。 */
			size: 104,
			/** 底部药丸头像边长（px）。 */
			pillSize: 26,
			/** mouth.mode: "auto" = 只有默认立绘才画嘴；"on" = 一直画；"off" = 不画。 */
			mouth: { mode: "auto", x: 52, y: 72.5, w: 16.5, h: 14 },
			/** anim.chew = 一个咀嚼周期时长（秒）。 */
			anim: { chew: 0.54, blush: true, nod: true },
			/** confirm.enabled = 拖上去之后先弹确认（默认开，可在设置里关掉）。 */
			confirm: { enabled: true },
			/**
			 * 设置页里可折叠区块的展开状态（持久化，刷新后保持）。
			 * 「文案」和「最近吃掉」很长，默认收起，让设置页一眼能看全。
			 */
			ui: { open: { text: false, eaten: false } },
			/** text.* = 可自定义文案；留空字符串表示"不显示"。 */
			text: { ...DEFAULT_TEXT }
		};

		/**
		 * 与默认配置深合并，顺手把越界/脏数据夹回合法范围。
		 * @param {unknown} raw - localStorage 里读出来的东西。
		 * @returns {typeof DEFAULT_CONFIG} 可用的配置。
		 */
		function normalizeConfig(raw) {
			const d = DEFAULT_CONFIG;
			const s = raw !== null && typeof raw === "object" ? raw : {};
			const num = (value, fallback, min, max) => {
				const n = Number(value);
				return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
			};
			const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
			const image = s.image !== null && typeof s.image === "object" ? s.image : {};
			const mouth = s.mouth !== null && typeof s.mouth === "object" ? s.mouth : {};
			const anim = s.anim !== null && typeof s.anim === "object" ? s.anim : {};
			const confirm = s.confirm !== null && typeof s.confirm === "object" ? s.confirm : {};
			const ui = s.ui !== null && typeof s.ui === "object" ? s.ui : {};
			const open = ui.open !== null && typeof ui.open === "object" ? ui.open : {};
			const text = s.text !== null && typeof s.text === "object" ? s.text : {};
			// 文案只看是不是字符串：空串是用户的选择（"不显示"），不能被默认值顶掉。
			const textOut = {};
			for (const [key, fallback] of Object.entries(d.text)) {
				textOut[key] = typeof text[key] === "string" ? text[key] : fallback;
			}
			return {
				v: 1,
				image: {
					mode: pick(image.mode, ["widget", "custom"], d.image.mode),
					custom: typeof image.custom === "string" ? image.custom : d.image.custom
				},
				size: num(s.size, d.size, 56, 220),
				pillSize: num(s.pillSize, d.pillSize, 16, 48),
				mouth: {
					mode: pick(mouth.mode, ["auto", "on", "off"], d.mouth.mode),
					x: num(mouth.x, d.mouth.x, -20, 120),
					y: num(mouth.y, d.mouth.y, -20, 120),
					w: num(mouth.w, d.mouth.w, 2, 80),
					h: num(mouth.h, d.mouth.h, 2, 80)
				},
				anim: {
					chew: num(anim.chew, d.anim.chew, 0.2, 1.6),
					blush: anim.blush !== false,
					nod: anim.nod !== false
				},
				// 默认开：只有显式 false 才关掉
				confirm: { enabled: confirm.enabled !== false },
				// 折叠状态：只有显式 true 才算展开（默认都收起）
				ui: { open: { text: open.text === true, eaten: open.eaten === true } },
				text: textOut
			};
		}

		let config = DEFAULT_CONFIG;
		try {
			const stored = window.localStorage.getItem(CONFIG_KEY);
			if (stored !== null) config = normalizeConfig(JSON.parse(stored));
		} catch (error) {
			console.warn(`[${NS}] 读取本地配置失败，用默认值`, error);
		}

		const configListeners = new Set();
		/** 配置是否真的落盘了（超配额时为 false，界面要给提示）。 */
		let configPersisted = true;

		/**
		 * 局部更新配置并通知所有订阅者。
		 * @param {object} patch - 形如 `{ size: 120 }` 或 `{ mouth: { x: 50 } }`。
		 * @returns {void}
		 */
		function updateConfig(patch) {
			const next = { ...config };
			for (const [key, value] of Object.entries(patch)) {
				next[key] = value !== null && typeof value === "object" && !Array.isArray(value)
					? { ...config[key], ...value }
					: value;
			}
			config = normalizeConfig(next);
			try {
				window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
				configPersisted = true;
			} catch (error) {
				configPersisted = false;
				console.warn(`[${NS}] 本地配置写不进去（多半是图片太大超出 localStorage 配额）`, error);
			}
			for (const fn of configListeners) {
				try { fn(config) } catch (error) { console.error(`[${NS}]`, error) }
			}
		}

		/** 过滤器自己的计数器，只给诊断桥看（排查"为什么没生效"）。 */
		const filterStats = { note: "not started", runs: 0, drops: 0, lastLedgerSize: 0, error: null };

		// ── 「最近吃掉」台账：撤销不再依赖那 4 秒的回执 ──────────────────
		// 只存 sessionId / 标题 / 时间，落 localStorage，设置页据此列出可撤销项。
		const EATEN_KEY = "dsh-session-eater/eaten";
		const EATEN_LIMIT = 12;
		const eatenListeners = new Set();

		/** 读取台账（容错：坏数据一律当空）。 */
		function readEaten() {
			try {
				const raw = window.localStorage.getItem(EATEN_KEY);
				const list = raw === null ? [] : JSON.parse(raw);
				if (!Array.isArray(list)) return [];
				return list.filter((item) => item !== null && typeof item === "object"
					&& typeof item.sessionId === "string");
			} catch {
				return [];
			}
		}

		/** 记一条台账并通知订阅者。 */
		function rememberEaten(entry) {
			const next = [entry, ...readEaten().filter((item) => item.sessionId !== entry.sessionId)]
				.slice(0, EATEN_LIMIT);
			try {
				window.localStorage.setItem(EATEN_KEY, JSON.stringify(next));
			} catch (error) {
				console.warn(`[${NS}] 台账写不进去`, error);
			}
			for (const fn of eatenListeners) {
				try { fn(next) } catch (error) { console.error(`[${NS}]`, error) }
			}
		}

		/** 撤销成功后把这条从台账里划掉。 */
		function forgetEaten(sessionId) {
			const next = readEaten().filter((item) => item.sessionId !== sessionId);
			try {
				window.localStorage.setItem(EATEN_KEY, JSON.stringify(next));
			} catch { /* 无所谓 */ }
			for (const fn of eatenListeners) {
				try { fn(next) } catch (error) { console.error(`[${NS}]`, error) }
			}
		}

		/** 订阅台账的 hook。 */
		function useEaten() {
			const [snap, setSnap] = useState(readEaten);
			useEffect(() => {
				eatenListeners.add(setSnap);
				setSnap(readEaten());
				return () => { eatenListeners.delete(setSnap) };
			}, []);
			return snap;
		}

		/** 相对时间，给台账列表用。 */
		function timeAgo(ts) {
			const seconds = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
			if (seconds < 60) return `${seconds} 秒前`;
			if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
			if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
			return `${Math.round(seconds / 86400)} 天前`;
		}

		/** 订阅配置的 hook。 */
		function useConfig() {
			const [snap, setSnap] = useState(config);
			useEffect(() => {
				configListeners.add(setSnap);
				setSnap(config);
				return () => { configListeners.delete(setSnap) };
			}, []);
			return snap;
		}

		/**
		 * 读一条可自定义文案。刻意读**当前** config（而不是闭包里的旧值），
		 * 这样改完文案后所有已经在跑的回调也立刻用新字符串。
		 * @param {string} key - DEFAULT_TEXT 的键。
		 * @returns {string} 文案；空串表示"不显示"。
		 */
		function textOf(key) {
			const value = config.text?.[key];
			return typeof value === "string" ? value : (DEFAULT_TEXT[key] ?? "");
		}

		/**
		 * 把前缀与自动附加的内容拼成一条回执；两边都可能为空。
		 * @param {string} prefix - 可自定义前缀。
		 * @param {string} suffix - 自动附加的内容（会话标题 / 错误信息）。
		 * @returns {string} 拼好的文案。
		 */
		function compose(prefix, suffix) {
			if (prefix === "") return suffix;
			if (suffix === "") return prefix;
			return `${prefix}：${suffix}`;
		}

		// ── 插件自己的运行时状态（药丸/投放区共用）──────────────────────────
		/** @type {{phase: string, detail: string, title: string, sessionId: string}} */
		let state = { phase: "idle", detail: "", title: "", sessionId: "" };
		const listeners = new Set();
		function setState(patch) {
			state = { ...state, ...patch };
			for (const fn of listeners) {
				try { fn(state) } catch (error) { console.error(`[${NS}]`, error) }
			}
		}
		function useEaterState() {
			const [snap, setSnap] = useState(state);
			useEffect(() => {
				listeners.add(setSnap);
				setSnap(state);
				return () => { listeners.delete(setSnap) };
			}, []);
			return snap;
		}

		// ── 形象与嘴的几何 ─────────────────────────────────────────────────
		/**
		 * 当前该用哪张形象图。
		 * @param {typeof DEFAULT_CONFIG} cfg - 配置。
		 * @returns {string} 图片 URL / dataURL。
		 */
		function resolveSrc(cfg) {
			if (cfg.image.mode === "custom" && cfg.image.custom !== "") return cfg.image.custom;
			return IMAGE_PRIMARY;
		}

		/**
		 * 加载图片拿原始尺寸（自定义图不是正方形时，嘴的坐标必须换算过）。
		 * @param {string} src - 图片地址。
		 * @returns {{w: number, h: number}} 原始像素尺寸。
		 */
		function useNaturalSize(src) {
			const [nat, setNat] = useState({ w: 0, h: 0 });
			useEffect(() => {
				let alive = true;
				setNat({ w: 0, h: 0 });
				const img = new Image();
				img.onload = () => { if (alive) setNat({ w: img.naturalWidth, h: img.naturalHeight }) };
				img.onerror = () => { if (alive) setNat({ w: 0, h: 0 }) };
				img.src = src;
				return () => { alive = false };
			}, [src]);
			return nat;
		}

		/**
		 * 图片在正方形形象框里的实际显示矩形（object-fit: contain 会留边）。
		 * @param {number} size - 框边长。
		 * @param {{w: number, h: number}} nat - 图片原始尺寸。
		 * @returns {{ox: number, oy: number, dw: number, dh: number}} 显示矩形。
		 */
		function displayRect(size, nat) {
			const nw = nat.w > 0 ? nat.w : size;
			const nh = nat.h > 0 ? nat.h : size;
			const scale = Math.min(size / nw, size / nh);
			const dw = nw * scale;
			const dh = nh * scale;
			return { ox: (size - dw) / 2, oy: (size - dh) / 2, dw, dh };
		}

		/**
		 * 把「图片内百分比」的嘴换算成形象框内的像素盒。
		 * @param {number} size - 框边长。
		 * @param {{w: number, h: number}} nat - 图片原始尺寸。
		 * @param {typeof DEFAULT_CONFIG.mouth} mouth - 嘴配置（中心 + 宽高，百分比）。
		 * @returns {{left: number, top: number, width: number, height: number}} 像素盒。
		 */
		function mouthBox(size, nat, mouth) {
			const rect = displayRect(size, nat);
			const cx = rect.ox + (mouth.x / 100) * rect.dw;
			const cy = rect.oy + (mouth.y / 100) * rect.dh;
			const width = (mouth.w / 100) * rect.dw;
			const height = (mouth.h / 100) * rect.dh;
			return { left: cx - width / 2, top: cy - height / 2, width, height };
		}

		/**
		 * 这个配置下要不要画嘴。
		 * @param {typeof DEFAULT_CONFIG} cfg - 配置。
		 * @returns {boolean} 要画则 true。
		 */
		function mouthEnabled(cfg) {
			if (cfg.mouth.mode === "off") return false;
			if (cfg.mouth.mode === "on") return true;
			// auto：只有默认立绘的嘴位是量过的，自定义图交给用户校准
			return cfg.image.mode === "widget";
		}

		// ── 会话列表相关的 DOM 工具 ────────────────────────────────────────
		/**
		 * 把一条会话从**客户端**会话列表里摘掉。
		 *
		 * 正常路径是宿主广播 `api-session/removed`；但如果那个会话在宿主进程里还是
		 * "活的"（被打开过），宿主会继续把它写在 baseline 里，刷新后可能又出现在
		 * 列表里。这里顺手调一次客户端的同款入口（就是 api-session/removed 的处理
		 * 函数），保证本地列表立刻干净；拿不到这个入口也无所谓，不影响主流程。
		 * @param ctx - 客户端 cordis 上下文。
		 * @param {string} sessionId - 会话 id。
		 * @returns {boolean} 确实调到了则 true。
		 */
		function dropLocalSummary(ctx, sessionId) {
			try {
				const sessions = ctx.get("sessions");
				if (typeof sessions?.handleSessionRemoved === "function") {
					sessions.handleSessionRemoved(sessionId);
					return true;
				}
			} catch (error) {
				console.warn(`[${NS}] 本地摘除会话行失败`, error);
			}
			return false;
		}

		/**
		 * 让宿主把某个会话从回收站搬回原位（宿主按桶里的 manifest 放回原路径）。
		 * @param {string} sessionId - 会话 id。
		 * @returns {Promise<object>} 宿主的返回体。
		 * @throws {Error} 宿主拒绝或网络失败时抛出。
		 */
		async function callRestore(sessionId) {
			const res = await fetch(`${API}/restore`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId }),
				cache: "no-store"
			});
			const payload = await res.json().catch(() => null);
			if (!res.ok || payload === null || payload.ok !== true) {
				throw new Error((payload && payload.error) || `HTTP ${res.status}`);
			}
			forgetEaten(sessionId);
			return payload;
		}

		/**
		 * 让台账里的会话从**客户端会话列表**里彻底消失。
		 *
		 * 为什么必须这么做：删掉一个会话之后，宿主进程里那个会话对象**还活着**
		 * （内核没给第三方插件 dispose 活着会话的入口），于是新开的页面重新拉 baseline 时
		 * 它又被塞回 `byId`。按工作区视图靠账目过滤，所以看不出来；但只要切到
		 * **「单列表」视图**，它就是直接按会话目录画行的 —— 被吃掉的会话会整排冒回来。
		 * （这才是"删了刷新还在"的真正来源，不是空白会话。）
		 *
		 * 这里订阅会话列表：只要台账里的 id 又出现就再摘一次。摘掉后订阅再触发时
		 * 它已经不在快照里了，所以不会递归。
		 * @param ctx - 客户端 cordis 上下文。
		 * @returns {(() => void)|undefined} 取消订阅的函数。
		 */
		function enforceEatenHidden(ctx) {
			const sessions = (() => { try { return ctx.get("sessions") } catch { return undefined } })();
			if (sessions === undefined || sessions.list === undefined) {
				filterStats.note = "no sessions service";
				return undefined;
			}
			filterStats.note = "started";

			const run = () => {
				filterStats.runs += 1;
				const hidden = readEaten().map((item) => item.sessionId);
				filterStats.lastLedgerSize = hidden.length;
				if (hidden.length === 0) return;
				const snap = sessions.list.getSnapshot?.();
				if (snap === null || snap === undefined || snap.byId === undefined) return;
				for (const id of hidden) {
					if (snap.byId[id] !== undefined) {
						dropLocalSummary(ctx, id);
						filterStats.drops += 1;
					}
				}
			};

			// 关键：store 是**先通知监听者、后换快照**的，所以在订阅回调里同步读快照
			// 拿到的还是旧值。延到下一个 tick 再读才是新快照；用 queued 合并同一轮的多次通知。
			let queued = false;
			const schedule = () => {
				if (queued) return;
				queued = true;
				setTimeout(() => { queued = false; run() }, 0);
			};

			// 再保险：客户端会话列表的 baseline 是**连接建立后异步**灌进来的，
			// 而 apply 跑得比它早 —— 光靠挂载时那一次 + 订阅实测都不够（订阅在
			// baseline 那一轮没触发）。这里补一串重试，覆盖"baseline 晚到"的情形；
			// 台账为空时 run() 会立刻返回，所以这点定时器几乎不花钱。
			run();
			const retries = [200, 600, 1500, 3000, 6000].map((ms) => setTimeout(run, ms));
			const unsubscribe = typeof sessions.list.subscribe === "function"
				? sessions.list.subscribe(schedule)
				: undefined;
			return () => {
				for (const timer of retries) clearTimeout(timer);
				try { unsubscribe?.() } catch { /* 无所谓 */ }
			};
		}

		/** 拖拽源是不是会话行（工作区行是 projectRow，不吃）。 */
		function sessionRowOf(target) {
			if (!(target instanceof Element)) return null;
			const row = target.closest("[role='treeitem']");
			if (row === null) return null;
			if (row.getAttribute("draggable") !== "true") return null;
			if (!/(^|[_-])sessionRow\b/.test(String(row.className))) return null;
			return row;
		}

		/** 找会话列表的滚动区，用来算投放区的位置。 */
		function listArea() {
			const slot = document.querySelector("[data-slot='sidebar.workspaces']");
			return slot === null ? null : slot.querySelector("[class*='listArea']") ?? slot;
		}

		/** 当前打开的会话 id（用来拒绝把自己喂掉）。 */
		function currentSessionId(ctx) {
			const snap = sessionListSnapshot(ctx);
			if (snap === null) return "";
			for (const key of ["current", "currentId", "selected", "selectedId"]) {
				if (typeof snap[key] === "string" && snap[key] !== "") return snap[key];
			}
			return "";
		}

		/**
		 * 点药丸 → 直接跳到「设置 → 会话喂鱼」。
		 *
		 * 设置面板的开合状态（`open` / `activeId`）是 SettingsRoot 内部的 React state，
		 * 内核**没有**对普通插件暴露「打开某个分区」的接口（`openSection` 只作为
		 * onboarding 步骤的 owner props 下发），所以这里只能走 DOM：
		 * 先点侧栏底部的设置触发器，等面板挂载，再点本分区的导航项。
		 *
		 * 选择器刻意**不绑类名** —— 构建产物的类名是哈希的（实测 `VOzbGW_trigger` /
		 * `VOzbGW_navCell`），客户端一升级就全变；只按 aria-label / 文本匹配。
		 * 面板是异步挂载的，所以等它渲染时用一小串重试。
		 *
		 * @returns {boolean} 是否找到了入口并点了下去（面板展开是异步的）。
		 */
		function openPluginSettings() {
			const visible = (el) => el !== null && el.offsetParent !== null;
			const navItem = () => [...document.querySelectorAll("button")]
				.find((button) => (button.textContent || "").trim() === NAV_LABEL && visible(button)) ?? null;

			// 面板已经开着（不分在哪个分区）→ 导航项就在场上，直接切过去
			const already = navItem();
			if (already !== null) {
				already.click();
				return true;
			}

			const labelOf = (button) => [
				button.getAttribute("aria-label") ?? "",
				button.getAttribute("title") ?? "",
				(button.textContent || "").trim()
			];
			// 优先用 data-slot 契约（稳定）；类名是哈希的，只能当兜底
			const trigger = document.querySelector("[data-slot='sidebar.settings'] button")
				?? [...document.querySelectorAll("button")]
					.find((button) => visible(button) && labelOf(button).some((text) => /^(设置|Settings)$/i.test(text.trim())))
				?? null;
			if (trigger === null) return false;
			trigger.click();

			let tries = 0;
			const tick = () => {
				const item = navItem();
				if (item !== null) { item.click(); return; }
				if (tries < 10) { tries += 1; setTimeout(tick, 80); }
			};
			setTimeout(tick, 60);
			return true;
		}

		/**
		 * 会话 token 用量缓存（sessionId → 用量对象或 null）。
		 *
		 * 不在 dragstart 预取：那个监听是 capture 阶段跑的，此时 dataTransfer 还没被会话行
		 * 写上 id，拿不到。改在 drop 时 await —— 宿主读的是**内核投影缓存**那个小 JSON
		 * （几十毫秒，不用解 5MB 的多帧 zstd），体感无延迟。
		 */
		const usageCache = new Map();

		/**
		 * 问宿主：这个会话消耗了多少 token。
		 * @param {string} sessionId - 会话 id。
		 * @returns {Promise<object|null>} 用量对象；读不到/超时返回 null（弹窗退回不带数字的文案）。
		 */
		async function fetchUsage(sessionId) {
			if (usageCache.has(sessionId)) return usageCache.get(sessionId);
			let usage = null;
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 900);
				const res = await fetch(`${API}/usage`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId }),
					cache: "no-store",
					signal: controller.signal
				});
				clearTimeout(timer);
				const payload = await res.json().catch(() => null);
				if (res.ok && payload !== null && payload.ok === true && typeof payload.total === "number") {
					usage = payload;
				}
			} catch {
				usage = null;
			}
			usageCache.set(sessionId, usage);
			return usage;
		}

		/**
		 * 把 token 数写成人看的样子。
		 * @param {number} n - token 数。
		 * @returns {string} `1234` / `12.3k` / `547.5M` / `1.20B`；非法值返回空串。
		 */
		function formatTokens(n) {
			if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
			if (n < 1000) return String(Math.round(n));
			if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
			if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
			return `${(n / 1e9).toFixed(2)}B`;
		}

		/**
		 * 会话列表快照。
		 * @param ctx - 客户端 cordis 上下文。
		 * @returns {object|null} 快照；拿不到时为 null。
		 */
		function sessionListSnapshot(ctx) {
			try {
				const sessions = ctx.get("sessions");
				const snap = sessions?.list?.getSnapshot?.();
				return snap !== null && typeof snap === "object" ? snap : null;
			} catch {
				return null;
			}
		}

		/**
		 * 会话是不是"空白会话"（列表里那个「新会话」：没有任何用户消息）。
		 *
		 * 这个判断很重要：DSH 会为工作区**按需保持**一个空白会话，所以把空白的
		 * 「新会话」喂掉之后，刷新/新建时它会以**新的 session id** 再冒出来 —— 看起来
		 * 就像"删了没生效"。所以这里干脆拒绝，并说明原因。
		 * @param ctx - 客户端 cordis 上下文。
		 * @param {string} sessionId - 会话 id。
		 * @returns {boolean|null} true/false；无法判断时 null。
		 */
		function isBlankSession(ctx, sessionId) {
			const snap = sessionListSnapshot(ctx);
			const summary = snap?.byId?.[sessionId];
			if (summary !== null && summary !== undefined && typeof summary.blank === "boolean") return summary.blank;
			return null;
		}

		/**
		 * DOM 兜底：空白会话行不渲染时间与 ⋯ 菜单（见 ui-workspace 的 SessionNodeItem）。
		 * @param {Element|null} row - 被拖拽的会话行。
		 * @returns {boolean} 判断不了时返回 false（宁可放行）。
		 */
		function rowLooksBlank(row) {
			if (row === null || row === undefined) return false;
			return row.querySelector("[class*='rowActions']") === null;
		}

		/**
		 * 读取用户挑的图片：等比缩到 ≤512px 再编码，免得把 localStorage 撑爆。
		 * @param {File} file - 用户选择的文件。
		 * @returns {Promise<string>} dataURL。
		 */
		async function fileToDataUrl(file) {
			const raw = await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(new Error("读取文件失败"));
				reader.readAsDataURL(file);
			});
			try {
				const bitmap = await createImageBitmap(file);
				const max = 512;
				const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.round(bitmap.width * scale));
				canvas.height = Math.max(1, Math.round(bitmap.height * scale));
				canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				bitmap.close?.();
				const webp = canvas.toDataURL("image/webp", 0.92);
				return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
			} catch {
				// SVG 之类 createImageBitmap 处理不了的，直接用原图
				return raw;
			}
		}

		// ══════════════════════════════════════════════════════════════════
		// CSS
		// ══════════════════════════════════════════════════════════════════
		const CSS = [
			// 药丸（席位内常驻）—— 兼「打开设置」的入口，所以是 pointer + 有焦点环
			`.dse-pill{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;`,
			`padding:4px 8px;border-radius:999px;border:1px dashed transparent;cursor:pointer;`,
			`color:var(--dsw-alias-label-tertiary,#9aa4bd);font-size:12px;line-height:18px;`,
			`transition:border-color .15s,background .15s,color .15s}`,
			// 悬停/键盘焦点排在上面那几条 [data-phase] 之前，让拖拽状态色优先
			`.dse-pill:hover{border-color:var(--dsw-alias-border-l3,#4a5578);`,
			`color:var(--dsw-alias-label-secondary,#c3cadd)}`,
			`.dse-pill:focus-visible{outline:2px solid #7fd6a0;outline-offset:2px}`,
			`.dse-pill[data-phase="armed"]{border-color:var(--dsw-alias-border-l3,#4a5578);`,
			`color:var(--dsw-alias-label-secondary,#c3cadd)}`,
			`.dse-pill[data-phase="over"]{border-color:#7fd6a0;color:#7fd6a0;background:rgba(127,214,160,.08)}`,
			`.dse-pill[data-phase="eating"],.dse-pill[data-phase="eaten"]{border-color:#ffb86b;color:#ffb86b}`,
			`.dse-pill[data-phase="error"]{border-color:#e5484d;color:#e5484d}`,
			`.dse-pill-head{position:relative;flex:none}`,
			`.dse-pill-head img{width:100%;height:100%;object-fit:contain;display:block;`,
			`filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}`,
			`.dse-pill-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,

			// 药丸那一行：只有药丸（撤销按钮已移除，撤销改走回执 + 设置里的台账）
			`.dse-foot{display:flex;align-items:center;gap:6px;width:100%;min-width:0}`,
			`.dse-foot > .dse-pill{flex:1 1 auto;min-width:0}`,

			// 确认弹窗：作为投放区的最后一个子元素，所以它落在会话列表里、鱼的正下方
			`.dse-confirm{width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;`,
			`display:flex;flex-direction:column;gap:8px;border-radius:12px;text-align:left;`,
			`background:rgba(8,12,24,.78);border:1px solid var(--dsw-alias-border-l3,#4a5578);`,
			`box-shadow:0 8px 24px rgba(0,0,0,.45);color:var(--dsw-alias-label-primary,#e6ebf5);`,
			`font-size:12px;line-height:17px}`,
			`.dse-confirm-ask{font-weight:600}`,
			`.dse-confirm-who{color:var(--dsw-alias-label-secondary,#c3cadd);word-break:break-all;`,
			`max-height:34px;overflow:hidden}`,
			`.dse-confirm-meta{color:var(--dsw-alias-label-tertiary,#9aa4bd);font-size:11px;line-height:15px;`,
			`font-variant-numeric:tabular-nums}`,
			`.dse-confirm-actions{display:flex;gap:8px;justify-content:flex-end}`,
			`.dse-confirm-btn{cursor:pointer;padding:3px 12px;border-radius:8px;font-size:12px;`,
			`line-height:18px;background:transparent;color:inherit;`,
			`border:1px solid color-mix(in srgb,currentColor 35%,transparent)}`,
			`.dse-confirm-btn:hover{background:color-mix(in srgb,currentColor 10%,transparent)}`,
			`.dse-confirm-btn:focus-visible{outline:2px solid #7fd6a0;outline-offset:1px}`,
			`.dse-confirm-danger{color:#ff8a8a;border-color:color-mix(in srgb,#ff8a8a 45%,transparent)}`,
			`.dse-confirm-danger:hover{background:color-mix(in srgb,#ff8a8a 12%,transparent)}`,

			// 投放区（拖拽时才出现的浮层，fixed 定位覆盖会话列表下缘）
			`.dse-plate{position:fixed;z-index:2147483000;display:flex;flex-direction:column;`,
			`align-items:center;justify-content:flex-end;gap:2px;box-sizing:border-box;`,
			`padding:8px;border-radius:16px;border:2px dashed var(--dsw-alias-border-l3,#4a5578);`,
			`background:linear-gradient(to top,rgba(12,18,38,.92),rgba(12,18,38,.62));`,
			`backdrop-filter:blur(2px);pointer-events:auto;`,
			`animation:dse-plate-in .16s ease-out}`,
			`.dse-plate[data-over="true"]{border-color:#7fd6a0;border-style:solid;`,
			`background:linear-gradient(to top,rgba(14,34,26,.94),rgba(12,18,38,.7));`,
			`box-shadow:0 0 0 4px rgba(127,214,160,.14)}`,
			`.dse-plate[data-phase="eating"]{border-color:#ffb86b;border-style:solid}`,
			`.dse-plate-note{color:#c3cadd;font-size:12px;line-height:16px;letter-spacing:.04em;`,
			`text-shadow:0 1px 3px rgba(0,0,0,.6)}`,

			// 形象本体
			`.dse-pet{position:relative;width:var(--dse-size,84px);height:var(--dse-size,84px);`,
			`transform-origin:50% 88%;transition:transform .16s ease-out;will-change:transform}`,
			`.dse-pet[data-over="true"]{animation:dse-nod var(--dse-chew,.54s) ease-in-out infinite}`,
			`.dse-pet[data-over="true"][data-nod="false"]{animation:none}`,
			`.dse-pet[data-phase="eating"]{animation:dse-gulp .45s ease-in-out}`,
			`.dse-pet img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;`,
			`display:block;filter:drop-shadow(0 3px 8px rgba(0,0,0,.45))}`,
			// 嘴：手绘 SVG（外轮廓=原画的深蓝描边 #16264f，口腔=暗梅红，舌头=粉）。
			// 位置/尺寸由 JS 按「图片实际显示矩形」算好后写成内联 px，见 mouthBox()。
			`.dse-mouth{position:absolute;overflow:visible;opacity:0;`,
			`transform:scaleY(.08) scaleX(.72);transform-origin:50% 8%;`,
			`transition:opacity .09s linear;pointer-events:none;`,
			`filter:drop-shadow(0 .5px .6px rgba(22,38,79,.45))}`,
			`.dse-pet[data-over="true"] .dse-mouth,.dse-pet[data-phase="eating"] .dse-mouth{`,
			`opacity:1;transform:none;animation:dse-chew var(--dse-chew,.54s) ease-in-out infinite}`,
			`.dse-pet[data-phase="eating"] .dse-mouth{animation-duration:calc(var(--dse-chew,.54s) * .5)}`,
			// 咀嚼时两颊泛起粉红（跟着咀嚼节奏脉动）。原画本来就有腮红，所以这里
			// 只做很轻的加成 —— 太浓会在 100px 下变成"过敏"。
			`.dse-pet[data-over="true"]::after{content:"";position:absolute;inset:0;pointer-events:none;`,
			`background-image:radial-gradient(circle at 33% 71%,rgba(243,150,172,.26),transparent 12%),`,
			`radial-gradient(circle at 69% 71%,rgba(243,150,172,.26),transparent 12%);`,
			`opacity:0;animation:dse-blush var(--dse-chew,.54s) ease-in-out infinite}`,
			`.dse-pet[data-blush="false"]::after{display:none}`,
			`@keyframes dse-blush{0%,100%{opacity:.34;transform:scale(1)}50%{opacity:.72;transform:scale(1.04)}}`,

			// 提示气泡 / 回执
			// 关键：带动撤销的成功回执**不自动消失**（留到用户点撤销或关掉），
			// 因为 4 秒的浮层太容易错过 —— 用户会以为"没有撤销按钮"。
			`.dse-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483001;`,
			`display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:12px;`,
			`max-width:min(560px,calc(100vw - 32px));box-sizing:border-box;`,
			`background:rgba(16,22,42,.96);border:1px solid var(--dsw-alias-border-l2,#39415e);`,
			`color:#e7ebf5;font-size:13px;line-height:18px;box-shadow:0 8px 24px rgba(0,0,0,.45);`,
			`animation:dse-plate-in .18s ease-out}`,
			`.dse-toast-msg{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}`,
			`.dse-toast button{flex:none;border:1px solid currentColor;background:transparent;border-radius:8px;`,
			`color:#7fd6a0;font-size:12px;padding:2px 10px;cursor:pointer;white-space:nowrap}`,
			`.dse-toast button.dse-toast-close{border:0;color:var(--dsw-alias-label-tertiary,#9aa4bd);`,
			`font-size:15px;line-height:15px;padding:2px 4px}`,
			`.dse-toast button.dse-toast-close:hover{color:#e7ebf5}`,
			`.dse-toast[data-kind="error"]{border-color:#e5484d}`,
			`.dse-toast[data-kind="error"] .dse-toast-msg{color:#ff9aa0}`,

			// 动画
			// 嘴与脑袋同一时长、同一 easing，读起来是"一口咬下去"而不是两个独立动作。
			// 张嘴 = 下颚往下掉（translateY 正值 + 纵向拉伸），闭嘴 = 下颚往上收
			// （translateY 负值 + 压成一条唇线）；脑袋方向相反，合嘴时正好低头咬下。
			`@keyframes dse-chew{`,
			`0%{transform:translateY(0) rotate(0deg) scale(1,1)}`,
			`22%{transform:translateY(-2.5%) rotate(-.8deg) scale(.93,.24)}`,
			`46%{transform:translateY(3%) rotate(.7deg) scale(1.06,1.16)}`,
			`70%{transform:translateY(-2%) rotate(1deg) scale(.94,.32)}`,
			`100%{transform:translateY(0) rotate(0deg) scale(1,1)}}`,
			`@keyframes dse-nod{`,
			`0%,100%{transform:rotate(0deg) translateY(0) scale(1,1)}`,
			`22%{transform:rotate(1.8deg) translateY(2%) scale(1.02,.98)}`,
			`46%{transform:rotate(-1.4deg) translateY(-1.5%) scale(.985,1.02)}`,
			`70%{transform:rotate(1.5deg) translateY(1.5%) scale(1.015,.99)}}`,
			`@keyframes dse-gulp{0%{transform:scale(1.08)}38%{transform:scale(1.3,.86)}`,
			`66%{transform:scale(.94,1.14)}100%{transform:scale(1)}}`,
			`@keyframes dse-plate-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}`,

			// 设置页
			`.dse-cfg{display:flex;flex-direction:column;gap:16px;max-width:640px;`,
			`color:var(--dsw-alias-label-primary,#e7ebf5);font-size:13px;line-height:20px}`,
			`.dse-cfg-hint{color:var(--dsw-alias-label-tertiary,#9aa4bd);font-size:11.5px;line-height:17px}`,
			// 卡片：比面板底色亮一档，圆角大一点，边框柔一点
			`.dse-cfg-block{display:flex;flex-direction:column;gap:11px;padding:14px 16px;border-radius:14px;`,
			`border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#2c3350) 80%,transparent);`,
			`background:color-mix(in srgb,var(--dsw-alias-bg-module-platform,rgba(255,255,255,.02)) 100%,transparent);`,
			`box-shadow:0 1px 2px rgba(0,0,0,.12)}`,
			// 标题前面加一小段渐变竖条，扫读时能立刻分辨分组
			`.dse-cfg-block > h3,.dse-cfg-fold-title{display:flex;align-items:center;gap:8px;margin:0;`,
			`font-size:13px;font-weight:600;letter-spacing:.02em}`,
			`.dse-cfg-block > h3::before,.dse-cfg-fold-title::before{content:"";flex:none;width:3px;height:12px;`,
			`border-radius:2px;background:linear-gradient(180deg,#7fd6a0,#3d8f66)}`,
			// 可折叠区块：标题整行可点，右侧带条数摘要；收起时正文不渲染
			`.dse-cfg-fold{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:2px 0;`,
			`background:transparent;border:none;color:inherit;font:inherit;cursor:pointer;text-align:left;`,
			`border-radius:8px;transition:color .15s}`,
			`.dse-cfg-fold:hover .dse-cfg-fold-title{color:var(--dsw-alias-brand-primary,#7fd6a0)}`,
			`.dse-cfg-fold:focus-visible{outline:2px solid #7fd6a0;outline-offset:2px}`,
			`.dse-cfg-fold-caret{flex:none;width:11px;font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa4bd);`,
			`transition:transform .18s ease}`,
			`.dse-cfg-fold[aria-expanded="true"] .dse-cfg-fold-caret{transform:rotate(90deg)}`,
			`.dse-cfg-fold-sum{flex:none;color:var(--dsw-alias-label-tertiary,#9aa4bd);font-size:11.5px;`,
			`border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#39415e) 70%,transparent);`,
			`border-radius:999px;padding:0 8px;line-height:16px}`,
			`.dse-cfg-fold-body{display:flex;flex-direction:column;gap:10px;animation:dse-fold-in .18s ease-out}`,
			`@keyframes dse-fold-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}`,
			`.dse-cfg-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}`,
			`.dse-cfg-row > .dse-cfg-label{flex:none;min-width:74px;color:var(--dsw-alias-label-secondary,#c3cadd)}`,
			`.dse-cfg-spacer{flex:1;min-width:0}`,
			// 分段控件
			`.dse-cfg-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,#39415e);border-radius:9px;`,
			`overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7ebf5) 6%,transparent)}`,
			`.dse-cfg-seg button{border:0;background:transparent;color:inherit;font:inherit;`,
			`padding:5px 14px;cursor:pointer;opacity:.66;transition:background .15s,opacity .15s}`,
			`.dse-cfg-seg button:hover{opacity:.9}`,
			`.dse-cfg-seg button[data-active="true"]{background:color-mix(in srgb,#7fd6a0 16%,transparent);`,
			`color:#9fe8bb;opacity:1}`,
			`.dse-cfg-seg button + button{border-left:1px solid var(--dsw-alias-border-l2,#39415e)}`,
			// 按钮
			`.dse-cfg-btn{border:1px solid var(--dsw-alias-border-l2,#39415e);background:transparent;color:inherit;`,
			`font:inherit;font-size:12.5px;border-radius:9px;padding:5px 14px;cursor:pointer;`,
			`transition:background .15s,border-color .15s,transform .06s}`,
			`.dse-cfg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}`,
			`.dse-cfg-btn:active{transform:translateY(1px)}`,
			`.dse-cfg-btn:focus-visible{outline:2px solid #7fd6a0;outline-offset:2px}`,
			`.dse-cfg-btn[data-kind="danger"]{color:#ff9aa0;border-color:rgba(229,72,77,.5)}`,
			`.dse-cfg-btn[data-kind="danger"]:hover{background:rgba(229,72,77,.12)}`,
			// 滑块 + 右侧数值胶囊
			`.dse-cfg input[type="range"]{width:190px;height:18px;accent-color:#7fd6a0;cursor:pointer;background:transparent}`,
			`.dse-cfg-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#c3cadd);`,
			`font-size:11.5px;min-width:54px;text-align:center;border-radius:7px;padding:1px 6px;`,
			`background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7ebf5) 9%,transparent);`,
			`border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#2c3350) 70%,transparent)}`,
			// 开关：把原生 checkbox 画成胶囊拨杆（a11y 不变，还是真 checkbox）
			`.dse-cfg input[type="checkbox"]{-webkit-appearance:none;appearance:none;position:relative;flex:none;`,
			`width:36px;height:20px;margin:0;border-radius:999px;cursor:pointer;`,
			`background:var(--dsw-alias-border-l2,#39415e);transition:background .18s ease}`,
			`.dse-cfg input[type="checkbox"]::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;`,
			`border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:transform .18s ease}`,
			`.dse-cfg input[type="checkbox"]:checked{background:#5cc98c}`,
			`.dse-cfg input[type="checkbox"]:checked::after{transform:translateX(16px)}`,
			`.dse-cfg input[type="checkbox"]:focus-visible{outline:2px solid #7fd6a0;outline-offset:2px}`,
			// 输入框
			`.dse-cfg input[type="text"],.dse-cfg input[type="url"]{flex:1;min-width:0;box-sizing:border-box;`,
			`background:color-mix(in srgb,var(--dsw-alias-label-primary,#e7ebf5) 7%,transparent);`,
			`border:1px solid var(--dsw-alias-border-l2,#39415e);`,
			`border-radius:8px;padding:0 10px;height:28px;color:inherit;font:inherit;font-size:12.5px;`,
			`transition:border-color .15s,box-shadow .15s}`,
			`.dse-cfg input[type="text"]:focus,.dse-cfg input[type="url"]:focus{outline:none;border-color:#5cc98c;`,
			`box-shadow:0 0 0 2px rgba(127,214,160,.18)}`,
			`.dse-cfg input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa4bd);opacity:.6}`,
			`.dse-cfg-field{display:flex;align-items:center;gap:10px}`,
			`.dse-cfg-field-label{flex:none;min-width:112px;color:var(--dsw-alias-label-secondary,#c3cadd);font-size:12.5px}`,
			`.dse-cfg-blank{flex:none;font-size:11px;color:#ffb86b;border:1px solid rgba(255,184,107,.45);`,
			`border-radius:999px;padding:0 7px}`,
			// 台账行：一行一条，行间细分隔线
			`.dse-cfg-eaten{display:flex;align-items:center;gap:10px;min-width:0;padding:5px 8px;border-radius:9px;`,
			`transition:background .15s}`,
			`.dse-cfg-eaten:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}`,
			`.dse-cfg-eaten + .dse-cfg-eaten{border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#2c3350) 55%,transparent);`,
			`border-radius:0 0 9px 9px}`,
			`.dse-cfg-eaten-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;`,
			`white-space:nowrap;color:var(--dsw-alias-label-primary,#e7ebf5)}`,
			`.dse-cfg-empty{display:flex;align-items:center;gap:8px;justify-content:center;padding:12px 0;`,
			`color:var(--dsw-alias-label-tertiary,#9aa4bd);font-size:12px}`,
			// 底部：和上面用一条分隔线断开
			`.dse-cfg-footer{border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#2c3350) 55%,transparent);`,
			`padding-top:12px;margin-top:2px}`,
			`.dse-cfg-stage-wrap{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}`,
			// 预览台：径向高光 + 极淡棋盘格（这样能看出自定义图的透明区域）
			`.dse-cfg-stage{position:relative;flex:none;border-radius:14px;box-sizing:border-box;`,
			`border:1px dashed var(--dsw-alias-border-l3,#4a5578);touch-action:none;cursor:crosshair;`,
			`background-image:radial-gradient(circle at 50% 40%,rgba(127,214,160,.07),transparent 70%),`,
			`linear-gradient(45deg,rgba(255,255,255,.028) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.028) 75%),`,
			`linear-gradient(45deg,rgba(255,255,255,.028) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.028) 75%);`,
			`background-size:auto,16px 16px,16px 16px;background-position:0 0,0 0,8px 8px;`,
			`transition:border-color .15s,background-color .15s}`,
			`.dse-cfg-stage[data-drop="true"]{border-color:#7fd6a0;background-color:rgba(127,214,160,.1)}`,
			`.dse-cfg-stage-pet{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}`,
			`.dse-cfg-cross{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;`,
			`border:1.5px solid #7fd6a0;box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none}`,
			`.dse-cfg-cross::before,.dse-cfg-cross::after{content:"";position:absolute;background:#7fd6a0;opacity:.75}`,
			`.dse-cfg-cross::before{left:50%;top:-7px;bottom:-7px;width:1px;margin-left:-.5px}`,
			`.dse-cfg-cross::after{top:50%;left:-7px;right:-7px;height:1px;margin-top:-.5px}`,
			`.dse-cfg-side{flex:1;min-width:230px;display:flex;flex-direction:column;gap:10px}`,
			`.dse-cfg-warn{color:#ffb86b}`,
			`.dse-cfg-img{width:76px;height:76px;object-fit:contain;border-radius:10px;`,
			`border:1px solid var(--dsw-alias-border-l1,#2c3350);background:rgba(0,0,0,.25)}`,

			`@media (prefers-reduced-motion:reduce){`,
			`.dse-pet,.dse-mouth,.dse-pet::after,.dse-plate,.dse-toast,.dse-cfg-fold-body{animation:none!important}}`
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			const tagId = `${NS}/client.css`;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * 样式自愈。
		 *
		 * 客户端半边热重载时，`apply` 里那条 ctx.effect 的清理函数会把我们注入的
		 * `<style>` 摘掉；正常情况下模块重载后 `apply` 会再跑一次补回来，但如果那次
		 * 重载失败（或页面已经开着、没人再跑 apply），药丸/投放区就会**裸奔**。
		 * 实测过别人的插件栽在这：表情包选择面板因为样式缺失，从 4 列网格退化成
		 * 774×1800 的一列竖排（`display:block`），刷新才好。
		 *
		 * 所以盯住 `<head>` 的 childList：只要它变了就确认一次自己的样式还在。
		 * `ensureCss()` 是幂等的，补一次不会再触发死循环。
		 * @param {HTMLElement} head - 被观察的 head。
		 * @returns {() => void} 取消观察。
		 */
		function watchCss(head) {
			if (typeof MutationObserver !== "function") return () => {};
			const observer = new MutationObserver(() => ensureCss());
			observer.observe(head, { childList: true });
			return () => observer.disconnect();
		}

		// ── 嘴的手绘矢量 ─────────────────────────────────────────────────
		// 在 100×100 的 viewBox 里画，外层 SVG 是扁框且 preserveAspectRatio="none"，
		// 所以这个近似圆的路径会自然摊成横向的"啊"口。
		// 上唇略平、下颚更深，和原画里下巴的走向一致。
		const MOUTH_LIP = "M 6 30 C 8 12 28 3 50 3 C 72 3 92 12 94 30 C 96 56 82 86 64 95 "
			+ "C 58 98 42 98 36 95 C 18 86 4 56 6 30 Z";
		// 口腔 = 同一路径绕偏下的支点缩 0.84 → 上唇比下唇厚，像真的唇线
		const MOUTH_INSET = "translate(50 57) scale(0.84) translate(-50 -57)";
		/** 每个实例一套唯一 id，避免多处渲染时 defs 互相覆盖。 */
		const MOUTH_SEQ = { n: 0 };

		/**
		 * 形象 + 嘴。
		 * @param props.size - 框边长 px。
		 * @param props.nat - 图片原始尺寸。
		 * @param props.cfg - 配置。
		 * @param props.over - 是否悬停（张嘴）。
		 * @param props.phase - 运行时状态。
		 * @param props.forceOpen - 预览用：忽略 over，直接把嘴张开。
		 */
		function Pet(props) {
			const { size, nat, cfg, over, phase, forceOpen = false } = props;
			const [failed, setFailed] = useState(false);
			const wantSrc = resolveSrc(cfg);
			useEffect(() => { setFailed(false) }, [wantSrc]);
			const src = failed && cfg.image.mode === "widget" ? IMAGE_FALLBACK : wantSrc;
			const [uid] = useState(() => `dse-mouth-${MOUTH_SEQ.n += 1}`);
			const showMouth = mouthEnabled(cfg);
			const box = mouthBox(size, nat, cfg.mouth);
			const open = forceOpen || over;
			const style = {
				"--dse-size": `${size}px`,
				"--dse-chew": `${cfg.anim.chew}s`
			};
			return jsx("div", {
				className: "dse-pet",
				"data-over": open ? "true" : "false",
				"data-phase": forceOpen ? "idle" : phase,
				"data-nod": cfg.anim.nod ? "true" : "false",
				"data-blush": cfg.anim.blush ? "true" : "false",
				style,
				children: [
					jsx("img", {
						key: "img",
						src,
						alt: "小胖鱼",
						draggable: false,
						onError: () => { setFailed(true) }
					}),
					showMouth ? jsxs("svg", {
						key: "mouth",
						className: "dse-mouth",
						viewBox: "0 0 100 100",
						preserveAspectRatio: "none",
						"aria-hidden": "true",
						style: {
							left: `${box.left}px`, top: `${box.top}px`,
							width: `${box.width}px`, height: `${box.height}px`
						},
						children: [
							jsxs("defs", { children: [
								jsx("clipPath", {
									id: `${uid}-clip`,
									children: jsx("path", { d: MOUTH_LIP, transform: MOUTH_INSET })
								}),
								jsxs("linearGradient", {
									id: `${uid}-cavity`, x1: "0", y1: "0", x2: "0", y2: "1",
									children: [
										jsx("stop", { offset: "0%", stopColor: "#3a1524" }),
										jsx("stop", { offset: "52%", stopColor: "#6d2b41" }),
										jsx("stop", { offset: "100%", stopColor: "#8b3651" })
									]
								}),
								jsxs("linearGradient", {
									id: `${uid}-tongue`, x1: "0", y1: "0", x2: "0", y2: "1",
									children: [
										jsx("stop", { offset: "0%", stopColor: "#ffc6d1" }),
										jsx("stop", { offset: "100%", stopColor: "#e2819a" })
									]
								})
							] }),
							// 唇线（原画的深蓝描边色）
							jsx("path", { d: MOUTH_LIP, fill: "#16264f" }),
							// 口腔
							jsx("path", { d: MOUTH_LIP, transform: MOUTH_INSET, fill: `url(#${uid}-cavity)` }),
							jsxs("g", {
								clipPath: `url(#${uid}-clip)`,
								children: [
									jsx("ellipse", { cx: 50, cy: 90, rx: 42, ry: 32, fill: `url(#${uid}-tongue)` }),
									jsx("ellipse", { cx: 41, cy: 85, rx: 11, ry: 4.5, fill: "#ffffff", opacity: 0.42 })
								]
							})
						]
					}) : null
				]
			});
		}

		// ══════════════════════════════════════════════════════════════════
		// 侧边栏药丸 + 投放区
		// ══════════════════════════════════════════════════════════════════
		/**
		 * 常驻药丸：平时在会话列表下缘显示，拖拽时展开成大投放区。
		 * @param props.ctx - 客户端 cordis 上下文（读当前会话用）。
		 */
		function Eater(props) {
			const { ctx } = props;
			const cfg = useConfig();
			const snap = useEaterState();
			const dragRow = useRef(null);
			const [over, setOver] = useState(false);
			const [plateRect, setPlateRect] = useState(null);
			const [toast, setToast] = useState(null);
			const toastTimer = useRef(0);

			const phase = snap.phase;
			const nat = useNaturalSize(resolveSrc(cfg));
			// 投放区在「已武装 / 悬停 / 正在吃 / 刚吃完」期间都留在场上 —— 注意
			// 不能只用 phase === "armed"：指针一进投放区 phase 就变 "over"，
			// 那样投放区会在被悬停的瞬间被自己卸载掉（曾经的真实 bug）。
			const plateVisible = phase === "armed" || phase === "over" || phase === "confirm"
				|| phase === "eating" || phase === "eaten";

			const showToast = useCallback((next) => {
				setToast(next);
				clearTimeout(toastTimer.current);
				// persistent（带撤销的那种）不自动消失：错过 4 秒就觉得"没有撤销按钮"。
				if (next !== null && next.persistent !== true) {
					toastTimer.current = setTimeout(() => setToast(null), next.kind === "error" ? 6000 : 5000);
				}
			}, []);
			useEffect(() => () => clearTimeout(toastTimer.current), []);

			// ── 文档级拖拽跟踪：只认会话行 ──────────────────────────────
			useEffect(() => {
				const onDragStart = (event) => {
					const row = sessionRowOf(event.target);
					if (row === null) return;
					dragRow.current = row;
					setOver(false);
					setState({ phase: "armed", detail: "", title: "", sessionId: "" });
				};
				const onDragEnd = (event) => {
					dragRow.current = null;
					setOver(false);
					// 落在自家投放区/药丸上的 drop 交给各自的 onDrop 处理，
					// 这里不要抢先把状态收回 idle。
					if (event.type === "drop" && event.target instanceof Element
						&& event.target.closest(".dse-plate, .dse-pill") !== null) return;
					if (state.phase === "armed" || state.phase === "over") setState({ phase: "idle" });
				};
				document.addEventListener("dragstart", onDragStart, true);
				document.addEventListener("dragend", onDragEnd, true);
				document.addEventListener("drop", onDragEnd, true);
				return () => {
					document.removeEventListener("dragstart", onDragStart, true);
					document.removeEventListener("dragend", onDragEnd, true);
					document.removeEventListener("drop", onDragEnd, true);
				};
			}, []);

			// ── 投放区几何：贴着会话列表下缘，拖拽开始/窗口尺寸变化时重算 ──
			const measure = useCallback(() => {
				const area = listArea();
				if (area === null) return;
				const rect = area.getBoundingClientRect();
				const height = Math.max(132, Math.min(190, Math.round(rect.height * 0.34)));
				setPlateRect({
					left: Math.round(rect.left + 8),
					width: Math.max(140, Math.round(rect.width - 16)),
					bottom: Math.max(12, Math.round(window.innerHeight - rect.bottom + 6)),
					height
				});
			}, []);
			useEffect(() => {
				if (!plateVisible) { setPlateRect(null); return }
				measure();
				window.addEventListener("resize", measure);
				return () => window.removeEventListener("resize", measure);
			}, [plateVisible, measure]);

			// 确认阶段按 Esc = 取消（回车交给按钮本身的原生行为，别再额外监听，
			// 免得「聚焦在取消上按回车」被两条路径抢）。
			useEffect(() => {
				if (phase !== "confirm") return undefined;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					setState({ phase: "idle" });
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [phase]);

			// ── 吃掉一只会话 ────────────────────────────────────────────
			const eat = useCallback(async (sessionId, title) => {
				setState({ phase: "eating", sessionId, title: title || sessionId });
				try {
					const res = await fetch(`${API}/delete`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId }),
						cache: "no-store"
					});
					const payload = await res.json().catch(() => null);
					if (!res.ok || payload === null || payload.ok !== true) {
						throw new Error((payload && payload.error) || `HTTP ${res.status}`);
					}
					setState({ phase: "eaten", sessionId, title: title || sessionId });
					dropLocalSummary(ctx, sessionId);
					rememberEaten({ sessionId, title: title || sessionId, at: Date.now() });
					const undoLabel = textOf("restore");
					showToast({
						kind: "ok",
						persistent: true,
						message: compose(textOf("eaten"), title || sessionId),
						action: undoLabel === "" ? null : { label: undoLabel, run: () => restore(sessionId) }
					});
					setTimeout(() => { if (state.phase === "eaten") setState({ phase: "idle" }) }, 1200);
				} catch (error) {
					const message = String((error && error.message) || error);
					setState({ phase: "error", detail: message });
					showToast({ kind: "error", message: compose(textOf("failed"), message) });
					setTimeout(() => { if (state.phase === "error") setState({ phase: "idle" }) }, 2400);
				}
			}, [showToast]);

			const restore = useCallback(async (sessionId) => {
				try {
					await callRestore(sessionId);
					setToast(null);
					showToast({ kind: "ok", message: textOf("restored") });
					setTimeout(() => window.location.reload(), 700);
				} catch (error) {
					showToast({ kind: "error", message: String((error && error.message) || error) });
				}
			}, [showToast]);

			// ── 投放区事件 ──────────────────────────────────────────────
			const readPayload = (event) => {
				let sessionId = "";
				try { sessionId = String(event.dataTransfer.getData("text/plain") || "") } catch { sessionId = "" }
				const row = dragRow.current;
				const title = row === null ? "" : String(row.textContent || "").trim().slice(0, 60);
				return { sessionId, title };
			};
			const onDragOver = (event) => {
				if (state.phase !== "armed" && state.phase !== "over") return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				if (!over) { setOver(true); setState({ phase: "over" }) }
			};
			const onDragLeave = (event) => {
				if (event.currentTarget.contains(event.relatedTarget)) return;
				setOver(false);
				if (state.phase === "over") setState({ phase: "armed" });
			};
			const onDrop = (event) => {
				event.preventDefault();
				event.stopPropagation();
				setOver(false);
				const row = dragRow.current;
				const { sessionId, title } = readPayload(event);
				if (!/^session-/.test(sessionId)) {
					setState({ phase: "idle" });
					return;
				}
				// 1) 空白会话（无任何用户消息）优先拦下：喂了也会被 DSH 再建一个，
				//    "删了又回来"的迷惑感就是这么来的，所以先给这条解释。
				const blank = isBlankSession(ctx, sessionId);
				if (blank === true || (blank === null && rowLooksBlank(row))) {
					setState({ phase: "idle" });
					showToast({ kind: "error", message: textOf("blank") });
					return;
				}
				// 2) 正在聊的这个会话不能喂（宿主还握着它的写句柄）
				const current = currentSessionId(ctx);
				if (current !== "" && current === sessionId) {
					setState({ phase: "idle" });
					showToast({ kind: "error", message: textOf("self") });
					return;
				}
				// 3) 确认这一步（默认开，设置里可关）：先停在投放区里问一句，
				//    点了「删除」才真吃 —— 松手即删对误拖太不友好。
				//    顺便问一次这个会话的 token 用量，写进询问语（拿不到就退回不带数字的那条）。
				if (cfg.confirm.enabled) {
					void (async () => {
						const usage = await fetchUsage(sessionId);
						setState({ phase: "confirm", sessionId, title: title || sessionId, usage });
					})();
					return;
				}
				void eat(sessionId, title);
			};

			const dropHandlers = {
				onDragOver,
				onDragLeave,
				onDrop,
				onDragEnter: (event) => { event.preventDefault() }
			};

			const plateNote = over ? textOf("over") : textOf("dropHint");
			// 确认阶段：让投放区按内容自适应高度（它是 bottom 定位的，所以往上长），
			// 否则固定高度会把「鱼 + 询问」挤在一起。
			const confirming = phase === "confirm";
			// 询问语：拿得到 token 用量就把 {tokens} 换成实际值（「…消耗了 547.5M token 的会话…」），
			// 拿不到（空白会话/投影缓存还没生成）就退回不带数字的那条，而不是硬写个"未知"。
			const confirmUsage = confirming ? (state.usage ?? null) : null;
			const confirmTokens = confirmUsage === null ? "" : formatTokens(confirmUsage.total);
			const askWithTokens = textOf("confirmAskTokens");
			const confirmAskText = confirmTokens !== "" && askWithTokens !== ""
				? askWithTokens.split("{tokens}").join(confirmTokens)
				: textOf("confirmAsk");
			// 副信息：几轮 + 缓存命中占比（用量大头通常是缓存读，写出来更诚实）
			const confirmMeta = confirmUsage === null ? "" : [
				confirmUsage.turns > 0 ? `${confirmUsage.turns} 轮` : "",
				confirmUsage.total > 0 && confirmUsage.cacheReadTokens > 0
					? `缓存命中 ${Math.round((confirmUsage.cacheReadTokens / confirmUsage.total) * 100)}%`
					: ""
			].filter(Boolean).join(" · ");
			const plate = plateVisible && plateRect !== null
				? jsxs("div", {
					className: "dse-plate",
					"data-over": over ? "true" : "false",
					"data-phase": phase,
					style: {
						left: `${plateRect.left}px`,
						width: `${plateRect.width}px`,
						bottom: `${plateRect.bottom}px`,
						height: confirming ? "auto" : `${plateRect.height}px`
					},
					...dropHandlers,
					children: [
						jsx(Pet, { key: "pet", size: cfg.size, nat, cfg, over, phase }),
						plateNote === "" || confirming ? null : jsx("div", {
							key: "note",
							className: "dse-plate-note",
							children: plateNote
						}),
						confirming ? jsx("div", {
							key: "confirm",
							className: "dse-confirm",
							role: "dialog",
							"aria-label": confirmAskText,
							children: [
								jsx("div", {
									key: "ask",
									className: "dse-confirm-ask",
									children: confirmAskText
								}),
								jsx("div", {
									key: "who",
									className: "dse-confirm-who",
									title: state.title,
									children: state.title
								}),
								confirmMeta === "" ? null : jsx("div", {
									key: "meta",
									className: "dse-confirm-meta",
									children: confirmMeta
								}),
								jsxs("div", {
									key: "actions",
									className: "dse-confirm-actions",
									children: [
										// 默认焦点给「取消」：回车误触不该把会话删掉
										jsx("button", {
											key: "no",
											type: "button",
											className: "dse-confirm-btn",
											"data-role": "confirm-cancel",
											autoFocus: true,
											onClick: () => { setState({ phase: "idle" }) },
											children: textOf("confirmNo") || "取消"
										}),
										jsx("button", {
											key: "yes",
											type: "button",
											className: "dse-confirm-btn dse-confirm-danger",
											"data-role": "confirm-ok",
											onClick: () => { void eat(state.sessionId, state.title) },
											children: textOf("confirmYes") || "删除"
										})
									]
								})
							]
						}, "confirm") : null
					]
				})
				: null;

			// 文案留空时药丸只剩图标（不给空 span，免得留出多余间距）
			const label = phase === "over" ? textOf("over")
				: phase === "armed" ? textOf("armed")
					: phase === "eating" ? textOf("eating")
						: phase === "eaten" ? textOf("eaten")
							: phase === "error" ? textOf("failed")
								: textOf("idle");

			// 药丸行**只留药丸**。这里原本还有一个「撤销最近吃掉的一条」按钮，
			// 但它读的是 localStorage 台账 —— 台账本来就要跨刷新保留，于是那个按钮
			// 刷新/重启后依然挂在那儿，看起来像个删不掉的按钮。
			// 撤销现在只走两条路：回执上的「撤销」（在内存里，刷新自然消失），
			// 以及「设置 → 会话喂鱼 → 最近吃掉」的 12 条台账。
			return jsxs(react.Fragment, {
				children: [
					jsxs("div", {
						key: "foot",
						className: "dse-foot",
						children: [
							jsxs("div", {
								key: "pill",
								className: "dse-pill",
								"data-phase": phase,
								"data-with-text": label === "" ? "false" : "true",
								// 点它 = 打开本插件的设置分区（同一个「设置」入口，少点两步）
								role: "button",
								tabIndex: 0,
								title: [textOf("hint"), `点击打开${NAV_LABEL}`].filter(Boolean).join(" · ") || undefined,
								onClick: () => { openPluginSettings() },
								onKeyDown: (event) => {
									if (event.key !== "Enter" && event.key !== " ") return;
									event.preventDefault();
									openPluginSettings();
								},
								style: { position: "relative" },
								...dropHandlers,
								children: [
									jsx("div", {
										className: "dse-pill-head",
										style: { width: `${cfg.pillSize}px`, height: `${cfg.pillSize}px` },
										children: jsx("img", {
											src: resolveSrc(cfg),
											alt: "",
											draggable: false,
											onError: (event) => {
												const img = event.currentTarget;
												if (cfg.image.mode === "widget" && !img.dataset.fallback) {
													img.dataset.fallback = "1";
													img.src = IMAGE_FALLBACK;
												}
											}
										})
									}),
									label === "" ? null : jsx("span", { className: "dse-pill-text", children: label })
								]
							})
						]
					}),
					plate,
					toast === null ? null : jsxs("div", {
						key: "toast",
						className: "dse-toast",
						"data-kind": toast.kind,
						children: [
							toast.message === "" ? null : jsx("span", { className: "dse-toast-msg", children: toast.message }),
							toast.action ? jsx("button", {
								type: "button",
								"data-role": "undo",
								onClick: () => { toast.action.run(); setToast(null) },
								children: toast.action.label
							}) : null,
							toast.persistent === true ? jsx("button", {
								type: "button",
								className: "dse-toast-close",
								title: "关闭",
								onClick: () => setToast(null),
								children: "✕"
							}) : null
						]
					})
				]
			});
		}

		// ══════════════════════════════════════════════════════════════════
		// 设置页：设置 → 会话喂鱼
		// ══════════════════════════════════════════════════════════════════
		/** 一行：左标签 + 右控件。 */
		function Row({ label, children }) {
			return jsxs("div", {
				className: "dse-cfg-row",
				children: [
					jsx("span", { className: "dse-cfg-label", children: label }),
					children
				]
			});
		}

		/** 带数值回显的滑块。 */
		function Slider({ label, value, min, max, step, unit, onChange }) {
			return jsxs(Row, {
				label,
				children: [
					jsx("input", {
						type: "range", min, max, step, value,
						onChange: (event) => onChange(Number(event.target.value))
					}),
					jsx("span", { className: "dse-cfg-num", children: `${value}${unit || ""}` })
				]
			});
		}

		/** 复选开关。`label` 留空时只渲染开关本身（给"标题 + 开关"那种一行用）。 */
		function Toggle({ label, checked, onChange, role }) {
			const control = [
				jsx("input", {
					key: "box",
					type: "checkbox",
					checked,
					"data-role": role,
					onChange: (event) => onChange(event.target.checked)
				}),
				jsx("span", { key: "state", className: "dse-cfg-hint", children: checked ? "开" : "关" })
			];
			if (label === "" || label === undefined) return jsx(react.Fragment, { children: control });
			return jsxs(Row, { label, children: control });
		}

		/**
		 * 可折叠的设置区块。
		 *
		 * 「文案」（15 段）和「最近吃掉」（最多 12 条）太占地方，收起来之后设置页一眼能看全；
		 * 收起时**正文不渲染**（不是藏起来），所以顺带省掉一大截 DOM。标题右侧给条数摘要，
		 * 不用展开也知道里面有多少东西。展开状态存在 config.ui.open 里，刷新后保持。
		 *
		 * @param props - id / title / summary / open / onToggle / children。
		 * @returns {object} 区块元素。
		 */
		function Collapsible({ id, title, summary, open, onToggle, children }) {
			return jsxs("div", {
				className: "dse-cfg-block",
				"data-fold": id,
				"data-open": open ? "true" : "false",
				children: [
					jsx("div", {
						className: "dse-cfg-row",
						children: jsxs("button", {
							type: "button",
							className: "dse-cfg-fold",
							"data-role": `fold-${id}`,
							"aria-expanded": open ? "true" : "false",
							onClick: onToggle,
							children: [
								// 箭头固定用 ▸，展开时由 CSS 转 90°（比换字形平滑）
								jsx("span", { className: "dse-cfg-fold-caret", children: "▸" }),
								jsx("span", { className: "dse-cfg-fold-title", children: title }),
								summary ? jsx("span", { className: "dse-cfg-fold-sum", children: summary }) : null
							]
						})
					}),
					open ? jsx("div", { className: "dse-cfg-fold-body", children }) : null
				]
			});
		}

		/**
		 * 一行文案输入。留空表示"不显示"，此时右侧给一个明确标记。
		 * @param props.label - 这一行在设置里的名字。
		 * @param props.hint - 说明文字。
		 * @param props.value - 当前文案。
		 * @param props.placeholder - 出厂文案（作为占位符提示）。
		 * @param props.onChange - 变更回调。
		 */
		function TextField({ label, hint, value, placeholder, onChange }) {
			return jsxs("div", {
				className: "dse-cfg-field",
				children: [
					jsx("span", { className: "dse-cfg-field-label", title: hint, children: label }),
					jsx("input", {
						type: "text",
						value,
						placeholder,
						onChange: (event) => onChange(event.target.value)
					}),
					value === ""
						? jsx("span", { className: "dse-cfg-blank", title: "留空 = 这段文字不显示", children: "不显示" })
						: null
				]
			});
		}

		/** 二选一分段控件。 */
		function Segmented({ label, value, options, onChange }) {
			return jsxs(Row, {
				label,
				children: jsx("div", {
					className: "dse-cfg-seg",
					children: options.map((option) => jsx("button", {
						type: "button",
						key: option.value,
						"data-active": String(value === option.value),
						onClick: () => onChange(option.value),
						children: option.label
					}, option.value))
				})
			});
		}

		/**
		 * 「设置 → 会话喂鱼」页面。
		 * @param props.close - 设置面板的关闭回调（宿主给的）。
		 */
		function SettingsSection(props) {
			void props;
			const cfg = useConfig();
			const eaten = useEaten();
			const nat = useNaturalSize(resolveSrc(cfg));
			const stageRef = useRef(null);
			const fileRef = useRef(null);
			const [dragging, setDragging] = useState(false);
			const [dropping, setDropping] = useState(false);
			const [notice, setNotice] = useState(null);
			const [urlDraft, setUrlDraft] = useState("");
			/** 预览框边长（固定），拖拽就是把指针换算成图片内百分比。 */
			const STAGE = 240;

			const flash = useCallback((text, kind = "ok") => {
				setNotice({ text, kind });
				setTimeout(() => setNotice(null), 4000);
			}, []);

			/** 设置页里的撤销：成功就直接刷新，让会话回到列表。 */
			const restore = useCallback(async (sessionId) => {
				try {
					await callRestore(sessionId);
					flash(textOf("restored") + "（正在刷新…）");
					setTimeout(() => window.location.reload(), 800);
				} catch (error) {
					flash(String((error && error.message) || error), "warn");
				}
			}, [flash]);

			/** 把指针位置换算成"图片内百分比"并写进配置。 */
			const pointToMouth = useCallback((clientX, clientY) => {
				const stage = stageRef.current;
				if (stage === null) return;
				const rect = stage.getBoundingClientRect();
				const shown = displayRect(STAGE, nat);
				const px = clientX - rect.left - shown.ox;
				const py = clientY - rect.top - shown.oy;
				updateConfig({
					mouth: {
						x: Math.round(Math.min(140, Math.max(-40, (px / shown.dw) * 100)) * 10) / 10,
						y: Math.round(Math.min(140, Math.max(-40, (py / shown.dh) * 100)) * 10) / 10
					}
				});
			}, [nat]);

			const onStagePointerDown = useCallback((event) => {
				if (event.button !== 0) return;
				if (cfg.mouth.mode === "off") {
					flash("先把「画嘴」打开，才能拖位置", "warn");
					return;
				}
				event.preventDefault();
				setDragging(true);
				pointToMouth(event.clientX, event.clientY);
			}, [cfg.mouth.mode, flash, pointToMouth]);

			useEffect(() => {
				if (!dragging) return undefined;
				const onMove = (event) => pointToMouth(event.clientX, event.clientY);
				const onUp = () => setDragging(false);
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp, { once: true });
				return () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
				};
			}, [dragging, pointToMouth]);

			/** 收下用户挑/拖进来的图片。 */
			const takeFile = useCallback(async (file) => {
				if (!file || !String(file.type).startsWith("image/")) {
					flash("请选择图片文件", "warn");
					return;
				}
				try {
					const dataUrl = await fileToDataUrl(file);
					// 自定义图的嘴位未知：先把嘴打开并提示去拖，用户不需要嘴可以自己切「关」
					updateConfig({ image: { mode: "custom", custom: dataUrl }, mouth: { mode: "on" } });
					flash(configPersisted
						? "已换上新图标 —— 在左边预览框拖绿圈把嘴挪到位（不需要嘴就切「关」）"
						: "图片太大，塞不进本地存储，仅本次有效");
				} catch (error) {
					flash(String(error && error.message) || "读取失败", "warn");
				}
			}, [flash]);

			const mouthPreview = mouthBox(STAGE, nat, cfg.mouth);
			const stage = jsxs("div", {
				ref: stageRef,
				className: "dse-cfg-stage",
				"data-drop": String(dropping),
				style: { width: `${STAGE}px`, height: `${STAGE}px` },
				onPointerDown: onStagePointerDown,
				onDragOver: (event) => { event.preventDefault(); setDropping(true) },
				onDragLeave: () => setDropping(false),
				onDrop: (event) => {
					event.preventDefault();
					setDropping(false);
					const file = event.dataTransfer?.files?.[0];
					if (file) void takeFile(file);
				},
				children: [
					jsx("div", {
						key: "pet",
						className: "dse-cfg-stage-pet",
						children: jsx(Pet, { size: STAGE, nat, cfg, over: true, phase: "idle", forceOpen: true })
					}),
					// 嘴心十字标（跟着配置走，拖拽时实时移动）
					mouthEnabled(cfg) ? jsx("div", {
						key: "cross",
						className: "dse-cfg-cross",
						style: { left: `${mouthPreview.left + mouthPreview.width / 2}px`, top: `${mouthPreview.top + mouthPreview.height / 2}px` }
					}) : null
				]
			});

			return jsxs("div", {
				className: "dse-cfg",
				children: [
					jsxs("div", { className: "dse-cfg-block", children: [
						jsx("h3", { children: "形象" }),
						jsx("div", {
							className: "dse-cfg-hint",
							children: "直接用余额挂件的形象，或换成你自己的图片（点击 / 拖进预览框 / 填网址）。"
						}),
						jsx(Segmented, {
							label: "来源",
							value: cfg.image.mode,
							options: [
								{ value: "widget", label: "跟随挂件" },
								{ value: "custom", label: "自定义" }
							],
							onChange: (mode) => updateConfig({ image: { mode } })
						}),
						// 文件/网址入口一直可见：挑完图自动切到"自定义"，不用先切模式
						jsxs(Row, { label: "图片", children: [
							jsx("img", {
								className: "dse-cfg-img",
								src: cfg.image.mode === "custom" && cfg.image.custom !== "" ? cfg.image.custom : IMAGE_PRIMARY,
								alt: ""
							}),
							jsx("button", {
								type: "button",
								className: "dse-cfg-btn",
								onClick: () => fileRef.current?.click(),
								children: "选择文件…"
							}),
							jsx("button", {
								type: "button",
								className: "dse-cfg-btn",
								disabled: cfg.image.mode !== "custom" && cfg.image.custom === "",
								onClick: () => {
									updateConfig({ image: { mode: "widget", custom: "" } })
									flash("已换回余额挂件的形象")
								},
								children: "清空"
							}),
							jsx("input", {
								ref: fileRef,
								type: "file",
								accept: "image/*",
								style: { display: "none" },
								onChange: (event) => {
									const file = event.target.files?.[0];
									event.target.value = "";
									if (file) void takeFile(file);
								}
							})
						] }),
						jsxs(Row, { label: "网址", children: [
							jsx("input", {
								type: "url",
								placeholder: "https://… 直接填图片地址",
								value: urlDraft,
								onChange: (event) => setUrlDraft(event.target.value)
							}),
							jsx("button", {
								type: "button",
								className: "dse-cfg-btn",
								disabled: !/^(https?:|data:image\/)/.test(urlDraft.trim()),
								onClick: () => {
									updateConfig({ image: { mode: "custom", custom: urlDraft.trim() }, mouth: { mode: "on" } });
									flash("已换成该网址的图片 —— 记得校准嘴的位置")
								},
								children: "使用"
							})
						] })
					] }),

					jsxs("div", { className: "dse-cfg-block", children: [
						jsx("h3", { children: "预览与嘴的位置" }),
						jsx("div", {
							className: "dse-cfg-hint",
							children: "在预览框里点一下或拖动，就能把嘴挪到你的图上正确的位置（绿圈是嘴心）。"
						}),
						jsxs("div", { className: "dse-cfg-stage-wrap", children: [
							stage,
							jsxs("div", { className: "dse-cfg-side", children: [
								jsx(Segmented, {
									label: "画嘴",
									value: cfg.mouth.mode,
									options: [
										{ value: "auto", label: "自动" },
										{ value: "on", label: "开" },
										{ value: "off", label: "关" }
									],
									onChange: (mode) => updateConfig({ mouth: { mode } })
								}),
								jsx("div", {
									className: "dse-cfg-hint",
									children: cfg.mouth.mode === "auto"
										? "自动 = 只有默认立绘（嘴位已量过）才画嘴。"
										: cfg.mouth.mode === "on"
											? "一直画嘴 —— 自定义图请先在左边拖到对的位置。"
											: "不画嘴，只有身体挤压 / 咀嚼动效。"
								}),
								jsx(Slider, {
									label: "嘴大小", value: cfg.mouth.w, min: 4, max: 40, step: 0.5, unit: "%",
									onChange: (w) => updateConfig({ mouth: { w, h: Math.round(w * 0.85 * 10) / 10 } })
								}),
								jsxs(Row, { label: "位置", children: [
									jsx("span", { className: "dse-cfg-hint", children: `x ${cfg.mouth.x}% · y ${cfg.mouth.y}%` }),
									jsx("div", { className: "dse-cfg-spacer" }),
									jsx("button", {
										type: "button",
										className: "dse-cfg-btn",
										onClick: () => updateConfig({ mouth: { ...DEFAULT_CONFIG.mouth } }),
										children: "回到默认位置"
									})
								] }),
								nat.w > 0 ? jsx("div", {
									className: "dse-cfg-hint",
									children: `当前图片 ${nat.w}×${nat.h}`
								}) : null
							] })
						] })
					] }),

					jsxs("div", { className: "dse-cfg-block", children: [
						jsx("h3", { children: "大小" }),
						jsx(Slider, {
							label: "投放区", value: cfg.size, min: 56, max: 220, step: 2, unit: "px",
							onChange: (size) => updateConfig({ size })
						}),
						jsx(Slider, {
							label: "药丸头像", value: cfg.pillSize, min: 16, max: 48, step: 1, unit: "px",
							onChange: (pillSize) => updateConfig({ pillSize })
						})
					] }),

					// 只有功能名 + 开关，不写说明（说明在"排障"里能查到，设置页保持干净）
					jsxs("div", { className: "dse-cfg-block", children: [
						jsxs("div", { className: "dse-cfg-row", children: [
							jsx("h3", { style: { flex: 1, margin: 0 }, children: "删除前确认" }),
							jsx(Toggle, {
								label: "",
								role: "toggle-confirm",
								checked: cfg.confirm.enabled,
								onChange: (enabled) => updateConfig({ confirm: { enabled } })
							})
						] })
					] }),

					jsxs("div", { className: "dse-cfg-block", children: [
						jsx("h3", { children: "动画" }),
						jsx(Slider, {
							label: "咀嚼周期", value: cfg.anim.chew, min: 0.2, max: 1.6, step: 0.02, unit: "s",
							onChange: (chew) => updateConfig({ anim: { chew: Math.round(chew * 100) / 100 } })
						}),
						jsx(Toggle, {
							label: "两颊粉红", checked: cfg.anim.blush,
							onChange: (blush) => updateConfig({ anim: { blush } })
						}),
						jsx(Toggle, {
							label: "点头咬合", checked: cfg.anim.nod,
							onChange: (nod) => updateConfig({ anim: { nod } })
						}),
						jsx("div", {
							className: "dse-cfg-hint",
							children: "系统开了「减少动态效果」时动画会自动关闭，这里的设置不影响无障碍行为。"
						})
					] }),

					jsx(Collapsible, {
						id: "text",
						title: "文案",
						summary: `${TEXT_FIELDS.length} 段`,
						open: cfg.ui.open.text,
						onToggle: () => updateConfig({
							ui: { open: { ...cfg.ui.open, text: !cfg.ui.open.text } }
						}),
						children: [
							jsx("div", {
								key: "hint",
								className: "dse-cfg-hint",
								children: "每一段都能改；留空就不显示那段文字（药丸只剩图标、投放区只剩鱼、回执只剩会话标题）。"
							}),
							jsx("div", {
								key: "reset",
								className: "dse-cfg-row",
								children: jsx("button", {
									type: "button",
									className: "dse-cfg-btn",
									onClick: () => { updateConfig({ text: { ...DEFAULT_TEXT } }); flash("文案已恢复出厂") },
									children: "恢复默认文案"
								})
							}),
							...TEXT_FIELDS.map(([key, label, hint]) => jsx(TextField, {
								key,
								label,
								hint,
								value: cfg.text[key],
								placeholder: DEFAULT_TEXT[key],
								onChange: (value) => updateConfig({ text: { [key]: value } })
							}))
						]
					}),

					jsx(Collapsible, {
						id: "eaten",
						title: "最近吃掉",
						summary: eaten.length === 0 ? "空" : `${eaten.length} 条`,
						open: cfg.ui.open.eaten,
						onToggle: () => updateConfig({
							ui: { open: { ...cfg.ui.open, eaten: !cfg.ui.open.eaten } }
						}),
						children: [
							jsx("div", {
								key: "hint",
								className: "dse-cfg-hint",
								children: "被吃掉的会话只是移进了回收站，这里可以随时捞回来"
									+ "（回执关掉之后，就靠这张表撤销）。"
							}),
							eaten.length === 0
								? jsx("div", { key: "empty", className: "dse-cfg-empty", children: "🐟 还没有吃掉任何会话" })
								: eaten.map((item) => jsxs("div", {
									className: "dse-cfg-eaten",
									key: item.sessionId,
									children: [
										jsx("span", {
											className: "dse-cfg-eaten-title",
											title: item.sessionId,
											children: item.title
										}),
										jsx("span", { className: "dse-cfg-hint", children: timeAgo(item.at) }),
										jsx("div", { className: "dse-cfg-spacer" }),
										jsx("button", {
											type: "button",
											className: "dse-cfg-btn",
											"data-role": "undo",
											onClick: () => void restore(item.sessionId),
											children: textOf("restore") === "" ? "撤销" : textOf("restore")
										})
									]
								}))
						]
					}),

					jsxs("div", { className: "dse-cfg-row dse-cfg-footer", children: [
						jsx("button", {
							type: "button",
							className: "dse-cfg-btn",
							"data-kind": "danger",
							onClick: () => { updateConfig({ ...DEFAULT_CONFIG }); flash("已恢复默认（含形象与嘴位）") },
							children: "恢复全部默认"
						}),
						jsx("div", { className: "dse-cfg-spacer" }),
						notice !== null ? jsx("span", {
							className: notice.kind === "warn" ? "dse-cfg-warn" : "dse-cfg-hint",
							children: notice.text
						}) : null
					] }),
					jsx("div", {
						className: "dse-cfg-hint",
						children: configPersisted
							? "配置存在本浏览器（localStorage），改完立刻生效，不用重启。"
							: "⚠ 本地存储写入失败（多为图片过大），当前配置仅本次会话有效。"
					})
				]
			});
		}

		/**
		 * 插件入口：注册侧边栏页脚席位 + 设置页，并尽早装上拖拽跟踪。
		 * @param ctx - 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			ensureCss();
			// 样式自愈：热重载期间样式被摘掉也能自己补回来，不用用户去刷新
			try {
				ctx.effect(() => watchCss(document.head), `${NS}: 样式自愈`);
			} catch (error) {
				console.warn(`[${NS}] 样式自愈没装上`, error);
			}

			// 宿主半边的版本：客户端读不到 package.json，所以问一次 /status。
			// 别在这里写死版本号 —— 写死过一次（0.3.0），包都到 0.4.x 了还在报 0.3.0。
			let hostVersion = "unknown";
			void fetch(`${API}/status`, { cache: "no-store" })
				.then((res) => res.json())
				.then((payload) => {
					if (typeof payload?.version === "string") hostVersion = payload.version;
				})
				.catch(() => { /* 宿主没应答就保持 unknown */ });

			// 诊断桥：排查"删了又回来"这类问题时不用开 devtools 猜。
			// 例：__dshSessionEater.sessionsProbe() 看当前会话/空白标记，
			//     __dshSessionEater.isBlank('session-xxx') 看某个会话是不是空白会话。
			const bridge = {
				config: () => JSON.parse(JSON.stringify(config)),
				setConfig: (patch) => updateConfig(patch),
				resetConfig: () => updateConfig({ ...DEFAULT_CONFIG }),
				persisted: () => configPersisted,
				lastEaten: () => readEaten(),
				filterStats: () => ({ ...filterStats }),
				hideEaten: () => {
					const snap = sessionListSnapshot(ctx);
					let dropped = 0;
					for (const item of readEaten()) {
						if (snap?.byId?.[item.sessionId] !== undefined) {
							dropLocalSummary(ctx, item.sessionId);
							dropped += 1;
						}
					}
					return dropped;
				},
				isBlank: (sessionId) => isBlankSession(ctx, String(sessionId)),
				current: () => currentSessionId(ctx),
				sessionsProbe: () => {
					const snap = sessionListSnapshot(ctx);
					const sessions = (() => { try { return ctx.get("sessions") } catch { return undefined } })();
					const workspaces = (() => { try { return ctx.get("workspaces") } catch { return undefined } })();
					const wsSnap = workspaces?.list?.getSnapshot?.();
					const accounted = [];
					for (const item of wsSnap?.items ?? []) accounted.push(...(item.sessionIds ?? []));
					return {
						hasService: sessions !== undefined,
						hasRemoveHook: typeof sessions?.handleSessionRemoved === "function",
						hasListSubscribe: typeof sessions?.list?.subscribe === "function",
						snapshotKeys: snap === null ? null : Object.keys(snap),
						current: currentSessionId(ctx),
						workspaceSessionIds: accounted,
						summaries: snap?.byId === undefined ? null : Object.entries(snap.byId).slice(0, 12)
							.map(([id, summary]) => ({ id, blank: summary?.blank, title: summary?.title }))
					};
				}
			};
			// version 用 getter：宿主版本是异步取到的，写成静态值就会一直停在旧号上
			Object.defineProperty(bridge, "version", { get: () => hostVersion, enumerable: true });
			window.__dshSessionEater = bridge;

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: NS,
				order: 40
			}, (ownerProps) => jsx(Eater, { ...ownerProps, ctx })), `${NS}: 会话喂鱼投放口`);

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: NS,
				order: 24,
				label: () => NAV_LABEL
			}, SettingsSection), `${NS}: 设置页`);

			// 已吃掉的会话不能因为宿主还记得它就重新出现在「单列表」视图里
			try {
				ctx.effect(() => {
					const dispose = enforceEatenHidden(ctx);
					return () => { if (typeof dispose === "function") dispose() };
				}, `${NS}: 隐藏已吃掉的会话`);
			} catch (error) {
				filterStats.error = String((error && error.stack) || error);
				console.error(`[${NS}] 隐藏已吃掉会话的过滤器启动失败`, error);
			}
		}

		exports.apply = apply;
		// `sessions` 必须声明在 inject 里：apply() 跑的时候它还没注册的话，
		// 「隐藏已吃掉会话」的过滤器会拿到 undefined 然后被静默跳过
		// （踩过一次：过滤器整个没生效，单列表视图里被吃掉的会话照旧出现）。
		exports.inject = ["slots", "sessions"];
		return module.exports;
	}
});
