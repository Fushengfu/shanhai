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

export interface ComputerUseService {
  /** 截取当前屏幕，返回 PNG 字节 */
  screenshot(): Promise<ArrayBuffer>
  clickAt(x: number, y: number): Promise<void>
  doubleClickAt(x: number, y: number): Promise<void>
  typeText(text: string): Promise<void>
  pressKey(key: string): Promise<void>
  scroll(direction: 'up' | 'down', amount?: number): Promise<void>
  /** OCR 识别截图中的文字及精确坐标；不传 imageBase64 则自动截屏识别 */
  ocr(imageBase64?: string): Promise<OcrWord[]>
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
  }
}
