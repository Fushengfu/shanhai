import type { ToolContract } from '@shanhai/tools'
import type { BrowserCookie, BrowserUseService } from './browser-use'

/** 截图上传回调：把 base64 上传到云存储，返回 https 公网链接；失败返回 null（调用方回退 base64） */
export type UploadImageFn = (imageBase64: string) => Promise<string | null>

/**
 * browser-use 插件：把「操作内置浏览器」收敛为一组统一工具，覆盖
 * 导航 → 定位 → 动作 → 提取 → 验证 的完整闭环，对齐 Taco browser-use 的能力面。
 *
 * 工具清单（17 个，按职责分组）：
 * - 导航/窗口：browser_create / browser_list / browser_navigate / browser_close
 * - 观察：browser_screenshot / browser_get_info / browser_get_content / browser_evaluate
 * - 动作：browser_click / browser_type / browser_scroll / browser_wait
 * - 诊断：browser_get_console_logs / browser_get_network_requests
 * - 会话态：browser_get_cookies / browser_set_cookie / browser_clear_cookies
 *
 * 设计原则（对齐 Taco browser-use）：
 * 1. 截图前必须明确目的，禁止无目的连续截图
 * 2. 选择器优先用稳定标识（id / name / data-testid）
 * 3. 页面跳转/异步加载后用 browser_wait 等待关键元素
 * 4. 排查错误先 browser_get_console_logs，再决定是否截图
 * 5. 浏览器定位为「测试 / 查资料」用途，所有操作免审批（不弹审批框，直接执行）
 */
export function createBrowserUseTools(service: BrowserUseService, uploadImage?: UploadImageFn): ToolContract[] {
  return [
    createTool(service),
    listTool(service),
    navigateTool(service),
    closeTool(service),
    screenshotTool(service, uploadImage),
    getInfoTool(service),
    getContentTool(service),
    evaluateTool(service),
    clickTool(service),
    typeTool(service),
    scrollTool(service),
    waitTool(service),
    consoleLogsTool(service),
    networkRequestsTool(service),
    getCookiesTool(service),
    setCookieTool(service),
    clearCookiesTool(service),
  ]
}

const appIdProp = { appId: { type: 'string', description: '浏览器窗口短标识，默认 default（单窗口时省略）' } }

/** browser_create：显式创建新的浏览器窗口，返回 appId */
function createTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_create',
    description:
      '创建新的浏览器窗口，返回窗口标识 appId。需要同时打开多个页面、或开启一个独立窗口时使用。url 必填（创建后立即打开该网址，避免空白窗口）；传入 title 给窗口标注用途（如「登录页」「数据采集」），方便后续用 browser_list 区分各窗口用途。后续 browser_navigate / browser_click 等操作用返回的 appId 定位该窗口。',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: '自定义窗口短标识（可选，省略则自动生成 default/win-2/win-3…）' },
        url: { type: 'string', description: '创建后立即打开的初始 URL（必填）' },
        title: { type: 'string', description: '窗口用途描述（可选，如「登录页」「数据采集」，供 AI 区分多窗口用途）' },
      },
      required: ['url'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!url) throw new Error('browser_create 需要 url 参数：创建浏览器窗口必须指定要打开的网址，避免打开空白窗口')
      const appId = await service.create(
        typeof args.appId === 'string' && args.appId ? args.appId : undefined,
        url,
        typeof args.title === 'string' && args.title ? args.title : undefined,
      )
      return { ok: true, appId }
    },
  }
}

/** browser_list：列出当前会话打开的浏览器窗口（appId 前缀过滤，会话隔离） */
function listTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_list',
    description: '列出当前打开的浏览器窗口（appId / URL / 标题）。多窗口操作前先调用它确认目标窗口。',
    inputSchema: { type: 'object', properties: { ...appIdProp } },
    riskLevel: 'readonly',
    execute: async (args) => {
      const windows = await service.list()
      // 会话级隔离：只返回 appId 等于或属于该前缀（会话）的窗口
      const prefix = typeof args.appId === 'string' && args.appId ? args.appId : undefined
      const filtered = prefix ? windows.filter((w) => w.appId === prefix || w.appId.startsWith(`${prefix}:`)) : windows
      return { windows: filtered }
    },
  }
}

/** browser_navigate：打开 URL */
function navigateTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_navigate',
    description:
      '在内置浏览器中打开指定 URL（如 https://example.com 或 http://localhost:3000）。打开本地前端页面、访问网站、进入某个网页时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整 URL' },
        ...appIdProp,
      },
      required: ['url'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const url = String(args.url ?? '')
      if (!url) throw new Error('browser_navigate 需要 url 参数')
      await service.navigate(url, typeof args.appId === 'string' ? args.appId : undefined)
      return { ok: true, url }
    },
  }
}

/** browser_close：关闭窗口 */
function closeTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_close',
    description: '关闭指定浏览器窗口，释放资源。不再需要该窗口时调用。',
    inputSchema: { type: 'object', properties: { ...appIdProp } },
    riskLevel: 'reversible',
    execute: async (args) => {
      await service.close(typeof args.appId === 'string' ? args.appId : undefined)
      return { ok: true }
    },
  }
}

/** browser_screenshot：截图 */
function screenshotTool(service: BrowserUseService, uploadImage?: UploadImageFn): ToolContract {
  return {
    name: 'browser_screenshot',
    description:
      '截取当前浏览器页面，返回截图链接（上传云存储后的 https URL）。仅在需要视觉确认时使用（如验证 UI 显示效果），截图前必须有明确目的。配合 image_analyze 分析截图内容。',
    inputSchema: { type: 'object', properties: { ...appIdProp } },
    riskLevel: 'readonly',
    execute: async (args) => {
      const buf = await service.screenshot(typeof args.appId === 'string' ? args.appId : undefined)
      const bytes = new Uint8Array(buf)
      const base64 = Buffer.from(bytes).toString('base64')
      if (uploadImage) {
        try {
          const url = await uploadImage(base64)
          if (url) return { imageUrl: url, byteLength: bytes.length }
        } catch {
          // 上传失败：回退 base64（保证截图功能不失效）
        }
      }
      return { imageBase64: base64, byteLength: bytes.length }
    },
  }
}

/** browser_get_info：页面基础信息 */
function getInfoTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_get_info',
    description: '获取当前页面基础信息（URL / 标题 / 视口尺寸）。确认页面是否加载到目标地址时使用。',
    inputSchema: { type: 'object', properties: { ...appIdProp } },
    riskLevel: 'readonly',
    execute: async (args) => {
      return service.getInfo(typeof args.appId === 'string' ? args.appId : undefined)
    },
  }
}

/** browser_get_content：提取页面内容 */
function getContentTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_get_content',
    description:
      '读取当前页面内容。selector 限定范围（CSS 选择器）；includeHtml=true 返回 HTML 而非纯文本。提取数据/文本、分析页面结构时优先用它而非截图。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器，限定要提取的元素（可选，默认整个页面）' },
        includeHtml: { type: 'boolean', description: '是否返回 HTML（默认 false 返回纯文本）' },
        ...appIdProp,
      },
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const text = await service.getContent(
        typeof args.selector === 'string' ? args.selector : undefined,
        typeof args.appId === 'string' ? args.appId : undefined,
        args.includeHtml === true,
      )
      return { content: text }
    },
  }
}

/** browser_evaluate：执行 JS */
function evaluateTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_evaluate',
    description:
      '在页面上下文执行 JS 表达式并返回结果。用于提取 DOM 数据、读取变量、分析页面结构（如 document.title、document.querySelectorAll(...)），效率高于截图。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JS 表达式（可带 return）' },
        ...appIdProp,
      },
      required: ['code'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const code = String(args.code ?? '')
      if (!code) throw new Error('browser_evaluate 需要 code 参数')
      const result = await service.evaluate(code, typeof args.appId === 'string' ? args.appId : undefined)
      return { result: stringifyResult(result) }
    },
  }
}

/** browser_click：点击元素 */
function clickTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_click',
    description:
      '点击页面元素（按 CSS 选择器定位，如 #submit、button.login、[data-testid=ok]）。浏览器用于测试/查资料，无需审批，直接执行。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '目标元素的 CSS 选择器' },
        ...appIdProp,
      },
      required: ['selector'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const selector = String(args.selector ?? '')
      if (!selector) throw new Error('browser_click 需要 selector 参数')
      await service.click(selector, typeof args.appId === 'string' ? args.appId : undefined)
      return { ok: true, selector }
    },
  }
}

/** browser_type：输入文本 */
function typeTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_type',
    description:
      '向输入元素（input/textarea）输入文本。selector 定位目标输入框；clear=true 先清空原内容再输入。填表单、搜索、登录等场景使用。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '目标输入元素的 CSS 选择器' },
        text: { type: 'string', description: '要输入的文本' },
        clear: { type: 'boolean', description: '是否先清空（默认 true）' },
        ...appIdProp,
      },
      required: ['selector', 'text'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const selector = String(args.selector ?? '')
      const text = String(args.text ?? '')
      if (!selector) throw new Error('browser_type 需要 selector 参数')
      await service.type(
        selector,
        text,
        typeof args.appId === 'string' ? args.appId : undefined,
        args.clear !== false,
      )
      return { ok: true, selector }
    },
  }
}

/** browser_scroll：滚动 */
function scrollTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_scroll',
    description: '滚动页面或指定元素。direction 为 up/down/left/right；amount 为滚动像素（默认 300）；selector 指定滚动容器（默认 window）。',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向' },
        amount: { type: 'number', description: '滚动像素（默认 300）' },
        selector: { type: 'string', description: '滚动容器选择器（默认 window）' },
        ...appIdProp,
      },
      required: ['direction'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const direction = (['up', 'down', 'left', 'right'] as const).includes(args.direction as never)
        ? (args.direction as 'up' | 'down' | 'left' | 'right')
        : 'down'
      await service.scroll(
        direction,
        typeof args.appId === 'string' ? args.appId : undefined,
        typeof args.amount === 'number' ? args.amount : undefined,
        typeof args.selector === 'string' ? args.selector : undefined,
      )
      return { ok: true, direction }
    },
  }
}

/** browser_wait：等待元素 */
function waitTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_wait',
    description: '等待指定元素出现（轮询检查 CSS 选择器）。页面跳转或异步加载后，先等关键元素就绪再操作。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '要等待的元素 CSS 选择器' },
        timeoutMs: { type: 'number', description: '超时毫秒（默认 10000）' },
        ...appIdProp,
      },
      required: ['selector'],
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const selector = String(args.selector ?? '')
      if (!selector) throw new Error('browser_wait 需要 selector 参数')
      await service.wait(
        selector,
        typeof args.appId === 'string' ? args.appId : undefined,
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      )
      return { ok: true, selector }
    },
  }
}

/** browser_get_console_logs：控制台日志 */
function consoleLogsTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_get_console_logs',
    description: '读取页面控制台日志（log/warn/error）。排查页面 JS 错误时优先使用，再决定是否截图。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回条数（默认 50）' },
        onlyErrors: { type: 'boolean', description: '只返回 error 级别（默认 false）' },
        ...appIdProp,
      },
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const logs = await service.getConsoleLogs(
        typeof args.appId === 'string' ? args.appId : undefined,
        typeof args.limit === 'number' ? args.limit : undefined,
        args.onlyErrors === true,
      )
      return { logs }
    },
  }
}

/** browser_get_network_requests：网络请求 */
function networkRequestsTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_get_network_requests',
    description: '获取页面最近的网络请求列表（URL / method / status / type）。分析接口调用、排查请求错误时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回条数（默认 50）' },
        ...appIdProp,
      },
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const requests = await service.getNetworkRequests(
        typeof args.appId === 'string' ? args.appId : undefined,
        typeof args.limit === 'number' ? args.limit : undefined,
      )
      return { requests }
    },
  }
}

/** browser_get_cookies：读 Cookie */
function getCookiesTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_get_cookies',
    description: '读取当前页面所有 Cookie（含 HttpOnly）。需要复用登录态、调试会话时使用。',
    inputSchema: { type: 'object', properties: { ...appIdProp } },
    riskLevel: 'readonly',
    execute: async (args) => {
      const cookies = await service.getCookies(typeof args.appId === 'string' ? args.appId : undefined)
      return { cookies }
    },
  }
}

/** browser_set_cookie：设置 Cookie */
function setCookieTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_set_cookie',
    description: '设置一个 Cookie。name/value 必填；domain/path/secure/httpOnly/sameSite/expires 可选。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Cookie 名称' },
        value: { type: 'string', description: 'Cookie 值' },
        domain: { type: 'string', description: '域名（可选）' },
        path: { type: 'string', description: '路径（可选，默认 /）' },
        secure: { type: 'boolean', description: '仅 HTTPS' },
        httpOnly: { type: 'boolean', description: 'HttpOnly' },
        sameSite: { type: 'string', description: 'SameSite' },
        expires: { type: 'number', description: '过期时间戳（秒）' },
        ...appIdProp,
      },
      required: ['name', 'value'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const cookie: BrowserCookie = {
        name: String(args.name),
        value: String(args.value),
        domain: typeof args.domain === 'string' ? args.domain : undefined,
        path: typeof args.path === 'string' ? args.path : undefined,
        secure: args.secure === true,
        httpOnly: args.httpOnly === true,
        sameSite: typeof args.sameSite === 'string' ? args.sameSite : undefined,
        expires: typeof args.expires === 'number' ? args.expires : undefined,
      }
      await service.setCookie(cookie, typeof args.appId === 'string' ? args.appId : undefined)
      return { ok: true, name: cookie.name }
    },
  }
}

/** browser_clear_cookies：清 Cookie */
function clearCookiesTool(service: BrowserUseService): ToolContract {
  return {
    name: 'browser_clear_cookies',
    description: '清除当前浏览器窗口所有 Cookie。会清空登录态，无需审批，直接执行。',
    inputSchema: { type: 'object', properties: { ...appIdProp } },
    riskLevel: 'reversible',
    execute: async (args) => {
      await service.clearCookies(typeof args.appId === 'string' ? args.appId : undefined)
      return { ok: true }
    },
  }
}

/** 把任意 JS 返回值转成可序列化的文本（对象 JSON.stringify，undefined 转空） */
function stringifyResult(result: unknown): string {
  if (result === undefined) return 'undefined'
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}
