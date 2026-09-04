import { Notification } from 'electron'
import { getRuntime } from './runtime'
import { showChatWindow, openApp } from './window-manager'

/**
 * 系统通知（会话任务结束等场景）：封装 Electron Notification，统一标题格式与点击行为。
 * - 标题：会话「xxx」任务完成
 * - 正文：任务最后一条助手回复的摘要（无摘要则回退为固定文案）
 * - 点击：唤起聊天窗口 + 切换到对应会话，让用户直接看到执行结果
 * 另含会员私信 / 好友申请两类提醒（点击打开「私信」应用窗口）。
 *
 * 【安全红线】私信通知只是「提醒人去看」，点击通知仅打开面板，
 * 绝不会把外部消息写进任何 Agent 上下文、也不会触发任何工具执行或审批。
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

/**
 * 会员私信到达提醒：点击打开「私信」窗口并直达该会话（onOpen 由 member-channel 注入定向事件）。
 * 【安全红线】通知只是「提醒人去看」，点击也只打开面板/会话，
 * 绝不把外部消息写进任何 Agent 上下文，也不会触发任何工具执行或审批。
 */
export function notifyDmMessage(fromName: string, preview: string, onOpen?: () => void): void {
  const cleanFrom = fromName?.trim() || '一位会员'
  const cleanPreview = preview?.trim()
  const body = cleanPreview ? cleanPreview.slice(0, 80) : '发来一条私信'
  const notification = new Notification({
    title: `${cleanFrom} 发来私信`,
    body,
  })
  notification.on('click', () => {
    void openApp('messages')
    onOpen?.()
  })
  notification.show()
}

/** 好友申请提醒：点击打开「私信」窗口并切到好友分区 */
export function notifyFriendRequest(fromName: string, onOpen?: () => void): void {
  const cleanFrom = fromName?.trim() || '一位会员'
  const notification = new Notification({
    title: `${cleanFrom} 请求添加你为好友`,
    body: '同意后才能互发私信，请在「私信 → 好友」里处理',
  })
  notification.on('click', () => {
    void openApp('messages')
    onOpen?.()
  })
  notification.show()
}
