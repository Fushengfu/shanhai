/**
 * computer-use 能力：操作 App（截图 / OCR 定位 / 鼠标 / 键盘 / 滚动）。
 *
 * 对齐 Taco computer-use 的核心铁律：先截图，禁止盲操作。
 * 完整闭环 = 截图 → OCR/视觉定位 → 统一动作 → 截图验证。
 *
 * 本包只定义能力缝接口 + mock 兜底；真实后端由宿主（Electron 主进程 / macOS 系统能力）提供。
 */

/** OCR 识别出的一个文字块及其精确坐标（左上角原点，像素坐标，相对截图，可直接用于 computer_action 的 click） */
export interface OcrWord {
  text: string
  /** 左上角 x（像素） */
  x0: number
  /** 左上角 y（像素） */
  y0: number
  /** 右下角 x（像素） */
  x1: number
  /** 右下角 y（像素） */
  y1: number
  /** 识别置信度 0~1 */
  confidence?: number
}

/** 统一桌面动作：点击 / 双击 / 输入 / 按键 / 滚动 */
export type ComputerAction =
  | { action: 'click'; x: number; y: number }
  | { action: 'doubleClick'; x: number; y: number }
  | { action: 'type'; text: string }
  | { action: 'key'; key: string }
  | { action: 'scroll'; direction: 'up' | 'down'; amount?: number }

/**
 * 无障碍写操作入参（对齐 computer-access 插件的 computer_access_perform_action 工具）。
 * 定位依据 = targetRole（AX 角色精确匹配）+ targetText（归一化后子串匹配 title/value/desc），
 * 二者至少填一个；action=setValue 时 value 必填。pid=0 或缺省 = 当前前台应用。
 */
export interface PerformActionParams {
  /** 动作：press（点击）/ increment（加）/ decrement（减）/ setValue（设值） */
  action: 'press' | 'increment' | 'decrement' | 'setValue'
  /** AX 角色精确匹配，如 AXButton/AXTextField/AXCheckBox/AXStaticText；可空（空=不限角色） */
  targetRole?: string
  /** 文本子串（归一化后匹配 title/value/desc）；与 targetRole 至少填一个 */
  targetText?: string
  /** setValue 时写入的文本 */
  value?: string
  /** 目标进程 pid；0 或缺省 = 当前前台应用 */
  pid?: number
  /** 定位遍历最大深度，默认 30 */
  maxDepth?: number
  /** 定位最多访问节点数，默认 2000 */
  maxNodes?: number
  [key: string]: unknown
}

/**
 * 无障碍写操作结果（透传 computer-access 插件的 computer_access_perform_action 结构化返回）。
 * 三态互斥、以 status 为唯一权威：success（回读到 value/selected/focused/existence 变化）/
 * unconfirmed（动作已送达但回读无变化，绝不冒充 success）/ failed（定位不到/元素 disabled/动作不支持/被隐私门禁拒）。
 * delivered 只表示「动作已送达」，绝不等于「生效」——这是防假成功的核心判据。
 */
export interface PerformActionResult {
  status: 'success' | 'unconfirmed' | 'failed'
  /** failed/unconfirmed 时的原因码（如 element_not_found / privacy_blocked_shanhai / dangerous_target …） */
  reason?: string
  action?: string
  targetRole?: string
  targetText?: string
  appName?: string
  bundleId?: string
  pid?: number
  windowTitle?: string
  matchedCount?: number
  /** 动作是否已送达（AXUIElementPerformAction/SetAttributeValue 返回 success） */
  delivered?: boolean
  /** AXError 码（0=成功送达） */
  performErrorCode?: number
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  changed?: { value?: boolean; selected?: boolean; focused?: boolean; existence?: boolean }
  targetInfo?: Record<string, unknown>
  message?: string
  platform?: string
  elapsedMs?: number
  [key: string]: unknown
}

/** 无障碍读树入参（对齐 computer-access 插件的 computer_access_read_tree 工具） */
export interface ReadTreeParams {
  /** 目标进程 pid；0 或缺省 = 当前前台应用 */
  pid?: number
  /** 遍历最大深度，默认 18 */
  maxDepth?: number
  /** 最多访问节点数，默认 800 */
  maxNodes?: number
  /** 输出文本字节硬上限，默认 20000 */
  maxBytes?: number
  /** 单字段字符裁剪长度，默认 120 */
  maxFieldLen?: number
  /** 是否输出位置尺寸，默认 true */
  includeGeometry?: boolean
  [key: string]: unknown
}

/**
 * 无障碍读树结果（透传 computer-access 插件的 computer_access_read_tree 结构化返回）。
 * 关键字段：status（ok/no_permission/…）、truncated/truncReason（是否截断）、text（语义树文本）、
 * bundleId（目标 App 的 bundle id，用于隐私边界判定）、message（错误时）。
 */
export interface ReadTreeResult {
  ok?: boolean
  status?: string
  platform?: string
  trusted?: boolean
  appName?: string
  bundleId?: string
  pid?: number
  windowTitle?: string
  mode?: string
  totalVisited?: number
  returnedLines?: number
  totalBytes?: number
  truncated?: boolean
  truncReason?: string
  text?: string
  message?: string
  [key: string]: unknown
}

export interface ComputerUseService {
  /** 截取当前屏幕，返回 PNG 字节 */
  screenshot(): Promise<ArrayBuffer>
  clickAt(x: number, y: number): Promise<void>
  doubleClickAt(x: number, y: number): Promise<void>
  typeText(text: string): Promise<void>
  pressKey(key: string): Promise<void>
  /**
   * 前台窗口命中校验（可选能力，缺陷②）：给定截图/OCR 物理像素坐标，返回「该坐标处最上层窗口 owner 是否 == 当前前台 App」。
   * 仅 darwin 实现（CGWindowList）；其它平台不实现。坐标点击前校验，误点背景窗口时停下报错而非盲点。
   * 校验脚本本身失败时降级返回 matched=true（放行），不阻断坐标点击兜底路径。
   */
  windowOwnerAtPoint?(x: number, y: number): Promise<{ matched: boolean; frontmost: string; ownerAtPoint: string }>
  scroll(direction: 'up' | 'down', amount?: number): Promise<void>
  /** OCR 识别截图中的文字及精确坐标；不传 imageBase64 则自动截屏识别 */
  ocr(imageBase64?: string): Promise<OcrWord[]>
  /**
   * 读当前前台（或指定 pid）应用的无障碍语义树（可选能力）。
   * 由宿主在 bootstrap 里注入，委托插件 computer-access 的 computer_access_read_tree（单一真相源，不复制进内核）。
   * 未装配（非 macOS / 插件未安装）时可能为 undefined，或返回降级结果；调用方据此回落到 screenshot+ocr。
   */
  readTree?(params?: ReadTreeParams): Promise<ReadTreeResult>
  /**
   * 按 role+text 定位当前前台（或指定 pid）应用的元素并执行 AX 写操作（press/increment/decrement/setValue，可选能力）。
   * 由宿主在 bootstrap 里注入，委托插件 computer-access 的 computer_access_perform_action（单一真相源，不复制进内核）。
   * 三态返回：success（回读到变化）/ unconfirmed（送达但未确认生效）/ failed（定位不到/disabled/门禁拒）。
   * 未装配（非 macOS / 插件未安装）时可能为 undefined，或返回降级结果；调用方据此回落到坐标 click/type 路径。
   */
  performAction?(params?: PerformActionParams): Promise<PerformActionResult>
}

/** mock：空操作（离线/测试兜底） */
export function createMockComputerUseService(): ComputerUseService {
  return {
    screenshot: async () => new ArrayBuffer(0),
    clickAt: async () => {},
    doubleClickAt: async () => {},
    typeText: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    ocr: async () => [],
    readTree: async () => ({
      ok: false,
      status: 'unsupported_platform',
      platform: process.platform,
      message: '无障碍读树未装配（mock 兜底），请改用 computer_screenshot + computer_ocr 定位',
    }),
    performAction: async () => ({
      status: 'failed',
      reason: 'unsupported_platform',
      platform: process.platform,
      message: '无障碍写操作未装配（mock 兜底），请改用 computer_action 坐标路径（click/type/key/scroll）',
    }),
  }
}
