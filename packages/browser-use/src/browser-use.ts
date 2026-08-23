/**
 * browser-use 能力：操作内置浏览器（导航 / 点击 / 输入 / 提取 / 截图 / 网络 / Cookie）。
 *
 * 对齐 Taco browser-use 的内置浏览器面板：agent 在任务执行过程中自主决定
 * 是否打开浏览器、访问哪个页面、执行哪些操作，用户不干预。
 *
 * 本包只定义能力缝接口 + mock 兜底；真实后端由宿主（Electron 主进程的 WebContentsView）
 * 注入，与 computer-use 的「接口在包内、实现在宿主」完全对称。
 */

/** 一个浏览器窗口的简要信息（多窗口管理用，第一版支持单窗口，appId 固定 'default'） */
export interface BrowserWindowInfo {
  /** 窗口短标识，默认 'default' */
  appId: string
  /** 窗口用途描述（创建窗口时传入，供 AI 区分多个窗口各自用途） */
  label?: string
  url: string
  /** 页面标题（网页 <title>，自动获取） */
  title: string
}

/** 页面基础信息（URL / 标题 / 视口） */
export interface BrowserInfo {
  url: string
  title: string
  /** 窗口用途描述（创建窗口时传入） */
  label?: string
  viewport: { width: number; height: number }
}

/** 控制台日志 */
export interface BrowserConsoleLog {
  /** log / warn / error / info */
  type: string
  text: string
}

/** 网络请求（最近 N 条） */
export interface BrowserNetworkRequest {
  url: string
  method: string
  status?: number
  type?: string
}

/** Cookie（含 HttpOnly） */
export interface BrowserCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
  expires?: number
}

/**
 * 浏览器能力缝：所有浏览器自动化操作都收敛到这个接口。
 * 定位元素优先用 CSS 选择器（id / name / data-testid 等稳定标识），
 * CDP 底层会先按选择器拿到元素坐标再派发真实鼠标/键盘事件。
 */
export interface BrowserUseService {
  /** 列出当前活跃的浏览器窗口 */
  list(): Promise<BrowserWindowInfo[]>
  /** 显式创建新的浏览器窗口，返回窗口标识 appId（可选自定义短名、初始 URL 与用途标题） */
  create(appId?: string, url?: string, title?: string): Promise<string>
  /** 打开指定 URL（默认窗口） */
  navigate(url: string, appId?: string): Promise<void>
  /** 截取当前页面，返回 PNG 字节 */
  screenshot(appId?: string): Promise<ArrayBuffer>
  /** 点击页面元素（按 CSS 选择器定位） */
  click(selector: string, appId?: string): Promise<void>
  /** 向输入元素输入文本（clear=true 先清空） */
  type(selector: string, text: string, appId?: string, clear?: boolean): Promise<void>
  /** 读取页面内容（文本；includeHtml=true 返回 HTML；selector 限定范围） */
  getContent(selector?: string, appId?: string, includeHtml?: boolean): Promise<string>
  /** 执行 JS 表达式，返回结果 */
  evaluate(code: string, appId?: string): Promise<unknown>
  /**
   * 在指定窗口页面里调用 `window.__dsChat(prompt, opts)` 并等待 Promise 结果（CDP 直连页面桥接脚本用）。
   * 长任务（网页版生成几十秒）需在实现侧加超时兜底；可选，mock / 非 Electron 后端可不实现。
   */
  chatWithPageBridge?(prompt: string, opts: { mode?: string; thinking?: boolean }, appId?: string): Promise<string>
  /** 页面基础信息 */
  getInfo(appId?: string): Promise<BrowserInfo>
  /** 等待元素出现（轮询检查选择器） */
  wait(selector: string, appId?: string, timeoutMs?: number): Promise<void>
  /** 滚动页面 */
  scroll(direction: 'up' | 'down' | 'left' | 'right', appId?: string, amount?: number, selector?: string): Promise<void>
  /** 控制台日志（排查 JS 错误优先） */
  getConsoleLogs(appId?: string, limit?: number, onlyErrors?: boolean): Promise<BrowserConsoleLog[]>
  /** 网络请求列表 */
  getNetworkRequests(appId?: string, limit?: number): Promise<BrowserNetworkRequest[]>
  /** 读取 Cookie */
  getCookies(appId?: string): Promise<BrowserCookie[]>
  /** 设置 Cookie */
  setCookie(cookie: BrowserCookie, appId?: string): Promise<void>
  /** 清除所有 Cookie */
  clearCookies(appId?: string): Promise<void>
  /** 显示并聚焦窗口（用户点击标签恢复被遮挡/最小化的窗口） */
  show(appId?: string): Promise<void>
  /** 关闭窗口 */
  close(appId?: string): Promise<void>
  /** 设置「创建窗口时是否直接显示」（运行时动态生效，只影响后续新建窗口；可选，mock 可不实现） */
  setShowOnCreate?(show: boolean): void
}

/** mock：空操作（CLI 模式 / 离线 / 测试兜底） */
export function createMockBrowserUseService(): BrowserUseService {
  const empty = { appId: 'default', url: '', title: '' }
  return {
    list: async () => [empty],
    create: async () => 'default',
    navigate: async () => {},
    screenshot: async () => new ArrayBuffer(0),
    click: async () => {},
    type: async () => {},
    getContent: async () => '',
    evaluate: async () => undefined,
    getInfo: async () => ({ url: '', title: '', viewport: { width: 0, height: 0 } }),
    wait: async () => {},
    scroll: async () => {},
    getConsoleLogs: async () => [],
    getNetworkRequests: async () => [],
    getCookies: async () => [],
    setCookie: async () => {},
    clearCookies: async () => {},
    show: async () => {},
    close: async () => {},
    setShowOnCreate: () => {},
  }
}
