/**
 * computer-use 能力：操作 App（截图 / 点击 / 输入 / 按键）。
 *
 * 真实后端由 Electron 提供（主进程截图 + 键鼠事件），本包只定义能力缝接口 + mock 兜底。
 */
export interface ComputerUseService {
  /** 截图（返回 PNG 字节） */
  screenshot(): Promise<ArrayBuffer>
  clickAt(x: number, y: number): Promise<void>
  typeText(text: string): Promise<void>
  pressKey(key: string): Promise<void>
}

/** mock：空操作（离线/测试兜底） */
export function createMockComputerUseService(): ComputerUseService {
  return {
    screenshot: async () => new ArrayBuffer(0),
    clickAt: async () => {},
    typeText: async () => {},
    pressKey: async () => {},
  }
}
