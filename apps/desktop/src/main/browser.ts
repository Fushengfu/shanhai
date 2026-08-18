import { BrowserWindow } from 'electron'
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
 * 会话级隔离：appId 由运行时注入（默认 = 会话 id，agent 传短名时拼接为「会话id:短名」），
 * 不同会话的浏览器窗口天然隔离，互不可见。
 *
 * 窗口默认可见（show=true），用户可直接看到 agent 操作的浏览器窗口，也可手动关闭；
 * agent 通过 browser_close 决定保留/关闭。
 */

const DEFAULT_APP_ID = 'default'

/** 控制台 / 网络日志环形上限：超出自动丢弃最旧条目，防止长期复用窗口导致内存无界增长 */
const MAX_LOG_ENTRIES = 500

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
  const show = opts?.show ?? true
  const windows = new Map<string, WindowState>()

  /** 取（或懒创建）指定 appId 的窗口状态 */
  const stateOf = (appId?: string, label?: string): WindowState => {
    const id = appId ?? DEFAULT_APP_ID
    let st = windows.get(id)
    if (st && !st.win.isDestroyed()) return st
    const win = new BrowserWindow({
      show,
      width: 1280,
      height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
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
    win.webContents.on('did-navigate', () => void enableDebugger(id, st))
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
      await dbg.sendCommand('Runtime.enable')
      await dbg.sendCommand('Network.enable')
    } catch {
      // 调试域未就绪时忽略，下一次操作重试
    }
  }

  return {
    async create(appId, url, title) {
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
      if (url) await st.win.webContents.loadURL(url)
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
      await st.win.webContents.loadURL(url)
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
      await dbg.sendCommand('Input.dispatchMouseEvent', mousePressed)
      await dbg.sendCommand('Input.dispatchMouseEvent', mouseReleased)
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
      await st.win.webContents.debugger.sendCommand('Input.insertText', { text })
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
  }
}
