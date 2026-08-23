import { Notification } from 'electron'
import { getRuntime } from './runtime'
import { showChatWindow } from './window-manager'

/**
 * 系统通知（会话任务结束等场景）：封装 Electron Notification，统一标题格式与点击行为。
 * - 标题：会话「xxx」任务完成
 * - 正文：任务最后一条助手回复的摘要（无摘要则回退为固定文案）
 * - 点击：唤起聊天窗口 + 切换到对应会话，让用户直接看到执行结果
 */
export function notifySessionTaskComplete(sessionId: string, title: string, summary: string): void {
  const cleanTitle = title?.trim() || '会话'
  const cleanSummary = summary?.trim()
  const body = cleanSummary ? cleanSummary.slice(0, 80) : '任务执行完成'

  const notification = new Notification({
    title: `会话「${cleanTitle}」任务完成`,
    body,
  })

  notification.on('click', () => {
    // 唤起聊天窗口并切到该会话，用户点击通知即可直接查看结果
    showChatWindow()
    getRuntime().switchSession(sessionId)
  })

  notification.show()
}
