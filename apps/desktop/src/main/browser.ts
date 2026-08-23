import { app, BrowserWindow } from 'electron'
import type {
  BrowserConsoleLog,
  BrowserCookie,
  BrowserInfo,
  BrowserNetworkRequest,
  BrowserUseService,
  BrowserWindowInfo,
} from '@shanhai/browser-use'

/**
 * Electron 内置浏览器后端：复用 Electron 自带 Chromium（零额外下载），
 * 用多窗口（Map<appId, BrowserWindow>）承载浏览器，通过 webContents 便捷 API + CDP 完成
 * 导航 / 点击 / 输入 / 提取 / 截图 / 网络 / Cookie 的完整自动化。
 *
 * 会话级归属：appId 由运行时注入（默认 = 会话 id，agent 传短名时拼接为「会话id:短名」），
 * 窗口按 appId 归属不同会话（多窗口管理、按会话过滤）。
 * 数据隔离策略：会话级默认窗口（appId 不含冒号，如「s-xxx」）共享固定 partition，
 * 跨会话共享登录态（登录一次全通用，用于 DeepSeek 网页版等）；
 * agent 临时窗口（appId 含冒号，如「s-xxx:default」）独立 partition，窗口级数据隔离。
 *
 * 窗口默认可见（show=true），用户可直接看到 agent 操作的浏览器窗口，也可手动关闭；
 * agent 通过 browser_close 决定保留/关闭。
 */

const DEFAULT_APP_ID = 'default'

/**
 * 窗口数据隔离策略：
 * - 会话级默认窗口（appId 不含冒号，如「s-xxx」「deepseek-bridge」）→ 共享固定 partition，
 *   跨会话共享登录态（登录一次全通用），用于 DeepSeek 网页版等需要复用登录态的页面。
 * - agent 临时窗口（appId 含冒号，如「s-xxx:default」「s-xxx:win-2」）→ 独立 partition，
 *   窗口级隔离，Cookie / localStorage / 缓存互不互通（测试、查资料等场景各自独立）。
 */
// persist: 前缀让共享 partition 持久化到磁盘（userData/Partitions/），重启后登录态保留；
// 不带 persist: 的是内存 session，应用退出即丢（这正是「每次重开都要重新扫码」的根因）。
const SHARED_PARTITION = 'persist:shanhai-browser-shared'
const partitionOf = (appId: string): string =>
  appId.includes(':') ? `shanhai-browser-${appId.replace(/[^a-zA-Z0-9_-]/g, '-')}` : SHARED_PARTITION

/** 控制台 / 网络日志环形上限：超出自动丢弃最旧条目，防止长期复用窗口导致内存无界增长 */
const MAX_LOG_ENTRIES = 500

/** 页面加载超时（毫秒）：防止 URL 加载失败/挂起导致 loadURL 永久 pending（白屏 + 任务卡死） */
const LOAD_TIMEOUT_MS = 30_000

/** 页面桥接调用超时（毫秒）：DeepSeek 网页版生成可达几十秒，兜底防止 CDP evaluate 永久挂起 */
const BRIDGE_CHAT_TIMEOUT_MS = 620_000

/**
 * 带超时的 loadURL：页面加载完成才 resolve，失败/超时抛错，绝不永久挂起。
 * Electron 的 webContents.loadURL() 在页面持续挂起（网络不通、证书错误、服务未启动等）时，
 * 其 Promise 可能既不 resolve 也不 reject，导致 await 永久卡住 —— 用 Promise.race 加超时兜底。
 */
function loadURLWithTimeout(win: BrowserWindow, url: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `页面加载超时（${LOAD_TIMEOUT_MS / 1000}s）: ${url}。可能网络不通、服务未启动或页面持续加载，可改用 browser_get_console_logs / browser_get_network_requests 排查。`,
          ),
        ),
      LOAD_TIMEOUT_MS,
    )
  })
  return Promise.race([
    // 中文语言：附加 Accept-Language，让 DeepSeek 等中文站点返回中文界面/内容
    win.webContents.loadURL(url, { extraHeaders: 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8\n' }),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 带超时的 CDP sendCommand：webContents.debugger.sendCommand 在 target 未就绪/响应丢失时
 * 可能永久 pending，导致整个工具调用卡死。加超时兜底，超时抛错（由上层决定降级或重试）。
 */
async function sendCommandWithTimeout(
  dbg: Electron.Debugger,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`CDP ${method} 超时（${Math.round(timeoutMs / 1000)}s），调试器未响应`)), timeoutMs)
  })
  return Promise.race([dbg.sendCommand(method, params), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 有界追加：超过上限时丢弃最旧条目（环形语义） */
function pushBounded<T>(arr: T[], item: T): void {
  arr.push(item)
  if (arr.length > MAX_LOG_ENTRIES) arr.splice(0, arr.length - MAX_LOG_ENTRIES)
}

/** 每个浏览器窗口的独立状态（控制台 / 网络日志随窗口隔离） */
interface WindowState {
  win: BrowserWindow
  /** 窗口用途描述（创建时传入，供 AI 区分窗口用途） */
  label: string
  consoleLogs: BrowserConsoleLog[]
  networkRequests: BrowserNetworkRequest[]
  pendingRequests: Map<string, BrowserNetworkRequest>
  debuggerAttached: boolean
  /** 程序主动 close（browser_close 工具 / 标签 ×）时才允许销毁；用户点窗口关闭按钮只隐藏 */
  allowClose: boolean
}

/** CDP 定位元素并取其中心点坐标（视口坐标） */
async function getElementCenter(win: BrowserWindow, selector: string): Promise<{ x: number; y: number }> {
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`
  const rect = (await win.webContents.executeJavaScript(js)) as { x: number; y: number } | null
  if (!rect) throw new Error(`未找到元素: ${selector}`)
  return rect
}

export function createElectronBrowserService(opts?: { show?: boolean }): BrowserUseService {
  let show = opts?.show ?? true
  const windows = new Map<string, WindowState>()

  // 应用退出时放行浏览器窗口关闭：这些窗口的 close 事件默认 preventDefault（点关闭只隐藏），
  // 若不置 allowClose 会中止 app.quit() 的退出流程（表现为「点托盘退出只隐藏窗口、进程不退出」）。
  app.on('before-quit', () => {
    for (const st of windows.values()) st.allowClose = true
  })

  /** 取（或懒创建）指定 appId 的窗口状态 */
  const stateOf = (appId?: string, label?: string): WindowState => {
    const id = appId ?? DEFAULT_APP_ID
    let st = windows.get(id)
    if (st && !st.win.isDestroyed()) return st
    const win = new BrowserWindow({
      show,
      width: 1280,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 会话级默认窗口共享 partition，agent 临时窗口独立 partition（见 partitionOf）
        partition: partitionOf(id),
      },
    })
    // 维护正常浏览器 UA（去掉 Electron / 应用名标记，避免被网站识别为自动化/爬虫）
    const cleanUa = win.webContents
      .getUserAgent()
      .replace(/\sElectron\/[\d.]+/g, '')
      .replace(/\sshanhai\/[\d.]+/g, '')
    win.webContents.setUserAgent(cleanUa)
    // 中文语言：Accept-Language 在 loadURL 时统一附加（见 loadURLWithTimeout），navigator.language 用页面注入兜底
    st = {
      win,
      label: label ?? '',
      consoleLogs: [],
      networkRequests: [],
      pendingRequests: new Map(),
      debuggerAttached: false,
      allowClose: false,
    }
    windows.set(id, st)
    // 用户点窗口关闭按钮 → 隐藏而非销毁，标签与窗口状态保持同步（点标签可恢复显示）
    win.on('close', (e) => {
      if (!st.allowClose) {
        e.preventDefault()
        win.hide()
      }
    })
    win.on('closed', () => windows.delete(id))
    // 导航后 CDP 执行上下文重置，标记需重新 attach；由后续操作的 enableDebugger 统一重新挂载。
    // 不在这里 fire-and-forget 调 enableDebugger，避免与 navigate/create 里的显式调用并发，导致 sendCommand 竞争挂起。
    win.webContents.on('did-navigate', () => {
      st.debuggerAttached = false
    })
    return st
  }

  /** 挂 CDP，监听控制台 + 网络（幂等；页面导航后重新 enable 调试域） */
  const enableDebugger = async (id: string, st: WindowState): Promise<void> => {
    const dbg = st.win.webContents.debugger
    if (!st.debuggerAttached) {
      try {
        dbg.attach('1.3')
      } catch {
        // 已 attach 时忽略
      }
      st.debuggerAttached = true
      dbg.on('message', (_event, method, params) => {
        if (method === 'Runtime.consoleAPICalled') {
          const p = params as { type: string; args?: Array<{ value?: unknown; type?: string }> }
          const text = (p.args ?? []).map((a) => (a.value === undefined ? a.type ?? '' : String(a.value))).join(' ')
          pushBounded(st.consoleLogs, { type: p.type, text })
        } else if (method === 'Network.requestWillBeSent') {
          const p = params as { requestId: string; request: { url: string; method: string }; type?: string }
          const req: BrowserNetworkRequest = { url: p.request.url, method: p.request.method, type: p.type }
          st.pendingRequests.set(p.requestId, req)
          if (st.pendingRequests.size > MAX_LOG_ENTRIES) {
            const oldest = st.pendingRequests.keys().next().value
            if (oldest !== undefined) st.pendingRequests.delete(oldest)
          }
          pushBounded(st.networkRequests, req)
        } else if (method === 'Network.responseReceived') {
          const p = params as { requestId: string; response: { status: number } }
          const req = st.pendingRequests.get(p.requestId)
          if (req) req.status = p.response.status
          st.pendingRequests.delete(p.requestId)
        }
      })
    }
    try {
      await sendCommandWithTimeout(dbg, 'Runtime.enable', {}, 5000)
      await sendCommandWithTimeout(dbg, 'Network.enable', {}, 5000)
    } catch {
      // 调试域未就绪时忽略，下一次操作重试
    }
  }

  return {
    async create(appId, url, title) {
      // url 必填：不传网址就不建窗口，避免「创建一个空白窗口（about:blank）弹给用户看」。
      // 工具层（browser_create）已强制必填，这里是后端兜底，防内部误调用直接 create 不传 url。
      if (!url) {
        throw new Error('browser_create 需要 url 参数：创建浏览器窗口必须指定要打开的网址，避免打开空白窗口')
      }
      let id = appId
      if (!id) {
        // 自动生成不重复的短名：default → win-2 → win-3 …
        id = DEFAULT_APP_ID
        let n = 2
        while (windows.has(id) && !windows.get(id)!.win.isDestroyed()) {
          id = `win-${n++}`
        }
      }
      const st = stateOf(id, title)
      await loadURLWithTimeout(st.win, url)
      await enableDebugger(id, st)
      return id
    },

    async list(): Promise<BrowserWindowInfo[]> {
      const out: BrowserWindowInfo[] = []
      for (const [id, st] of windows) {
        if (st.win.isDestroyed()) continue
        out.push({
          appId: id,
          label: st.label || undefined,
          url: st.win.webContents.getURL(),
          title: st.win.webContents.getTitle(),
        })
      }
      return out
    },

    async navigate(url, appId) {
      const id = appId ?? DEFAULT_APP_ID
      const st = stateOf(id)
      await loadURLWithTimeout(st.win, url)
      await enableDebugger(id, st)
    },

    async screenshot(appId) {
      const st = stateOf(appId)
      const image = await st.win.webContents.capturePage()
      const buf = image.toPNG()
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    },

    async click(selector, appId) {
      const st = stateOf(appId)
      await enableDebugger(appId ?? DEFAULT_APP_ID, st)
      const { x, y } = await getElementCenter(st.win, selector)
      const dbg = st.win.webContents.debugger
      const mousePressed = { type: 'mousePressed' as const, x, y, button: 'left', clickCount: 1 }
      const mouseReleased = { type: 'mouseReleased' as const, x, y, button: 'left', clickCount: 1 }
      await sendCommandWithTimeout(dbg, 'Input.dispatchMouseEvent', mousePressed as unknown as Record<string, unknown>)
      await sendCommandWithTimeout(dbg, 'Input.dispatchMouseEvent', mouseReleased as unknown as Record<string, unknown>)
    },

    async type(selector, text, appId, clear = true) {
      const st = stateOf(appId)
      await enableDebugger(appId ?? DEFAULT_APP_ID, st)
      const focusJs = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        ${clear ? `
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, '')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        ` : ''}
        el.focus()
        return true
      })()`
      const focused = (await st.win.webContents.executeJavaScript(focusJs)) as boolean
      if (!focused) throw new Error(`未找到输入元素: ${selector}`)
      await sendCommandWithTimeout(st.win.webContents.debugger, 'Input.insertText', { text })
    },

    async getContent(selector, appId, includeHtml = false) {
      const st = stateOf(appId)
      const js = includeHtml
        ? `(() => { const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'}; return el ? el.outerHTML : '' })()`
        : `(() => { const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'}; return el ? el.innerText : '' })()`
      return (await st.win.webContents.executeJavaScript(js)) as string
    },

    async evaluate(code, appId) {
      const st = stateOf(appId)
      return st.win.webContents.executeJavaScript(code)
    },

    async chatWithPageBridge(prompt, opts, appId) {
      const id = appId ?? DEFAULT_APP_ID
      const st = stateOf(id)
      // 调页面里的 window.__dsChat（返回 Promise），executeJavaScript 会 await 其结果；
      // 加超时兜底（网页版生成可达几十秒，页面卡住时绝不永久挂起）
      const js = `window.__dsChat(${JSON.stringify(prompt)}, ${JSON.stringify(opts)})`
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`页面桥接超时（${Math.round(BRIDGE_CHAT_TIMEOUT_MS / 1000)}s），DeepSeek 页面未返回结果`)), BRIDGE_CHAT_TIMEOUT_MS)
      })
      try {
        return await Promise.race([st.win.webContents.executeJavaScript(js) as Promise<string>, timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },

    async getInfo(appId): Promise<BrowserInfo> {
      const st = stateOf(appId)
      const viewport = (await st.win.webContents.executeJavaScript(
        '({ width: window.innerWidth, height: window.innerHeight })',
      )) as { width: number; height: number }
      return {
        url: st.win.webContents.getURL(),
        title: st.win.webContents.getTitle(),
        label: st.label || undefined,
        viewport,
      }
    },

    async wait(selector, appId, timeoutMs = 10000) {
      const st = stateOf(appId)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = (await st.win.webContents.executeJavaScript(
          `!!document.querySelector(${JSON.stringify(selector)})`,
        )) as boolean
        if (found) return
        await new Promise((r) => setTimeout(r, 200))
      }
      throw new Error(`等待元素超时: ${selector}`)
    },

    async scroll(direction, appId, amount = 300, selector) {
      const st = stateOf(appId)
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
      const js = selector
        ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollBy(${dx}, ${dy}); return true })()`
        : `(() => { window.scrollBy(${dx}, ${dy}); return true })()`
      const ok = (await st.win.webContents.executeJavaScript(js)) as boolean
      if (!ok) throw new Error(`未找到滚动容器: ${selector}`)
    },

    async getConsoleLogs(appId, limit = 50, onlyErrors = false) {
      const st = stateOf(appId)
      const filtered = onlyErrors ? st.consoleLogs.filter((l) => l.type === 'error') : st.consoleLogs
      return filtered.slice(-limit)
    },

    async getNetworkRequests(appId, limit = 50) {
      const st = stateOf(appId)
      return st.networkRequests.slice(-limit)
    },

    async getCookies(appId) {
      const st = stateOf(appId)
      const cookies = await st.win.webContents.session.cookies.get({})
      return cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expires: c.expirationDate,
      }))
    },

    async setCookie(cookie, appId) {
      const st = stateOf(appId)
      const url = cookie.domain
        ? `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path ?? '/'}`
        : st.win.webContents.getURL()
      await st.win.webContents.session.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite as 'unspecified' | 'no_restriction' | 'lax' | 'strict' | undefined,
        expirationDate: cookie.expires,
      })
    },

    async clearCookies(appId) {
      const st = stateOf(appId)
      await st.win.webContents.session.clearStorageData({ storages: ['cookies'] })
    },

    async show(appId) {
      const id = appId ?? DEFAULT_APP_ID
      const st = windows.get(id)
      if (st && !st.win.isDestroyed()) {
        if (st.win.isMinimized()) st.win.restore()
        st.win.show()
        st.win.focus()
      }
    },

    async close(appId) {
      const id = appId ?? DEFAULT_APP_ID
      const st = windows.get(id)
      if (st && !st.win.isDestroyed()) {
        // 程序主动关闭：真正销毁窗口（区别于用户点关闭按钮的隐藏）
        st.allowClose = true
        st.win.destroy()
        windows.delete(id)
      }
    },

    setShowOnCreate(v) {
      // 运行时切换「创建窗口是否直接显示」，影响后续 stateOf 新建的窗口；已存在窗口不受影响
      show = v
    },
  }
}
