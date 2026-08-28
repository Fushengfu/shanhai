import { BrowserWindow } from 'electron'

/**
 * 安全地向窗口发送 IPC 消息。
 *
 * 窗口关闭存在竞态：`win.isDestroyed()` 尚为 false 时，其 webContents 内部的 render frame
 * 可能已先销毁，此时直接 `win.webContents.send()` 会抛
 * `Error: Render frame was disposed before WebFrameMain could be accessed`，
 * 该异常若沿事件发射器（如 token 用量回调）冒泡回 agent 循环，可能打断正在执行的任务。
 * 这里同时检查 `webContents.isDestroyed()`，并用 try-catch 兜底最极端的竞态。
 */
export function safeSend(win: BrowserWindow | null | undefined, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, ...args)
  } catch {
    // 竞态兜底：检查通过后 frame 仍被销毁，吞掉异常避免打断调用方
  }
}
