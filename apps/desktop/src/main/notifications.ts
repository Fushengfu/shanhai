import { Notification } from 'electron'
import { getRuntime } from './runtime'
import { showChatWindow, openApp } from './window-manager'
import { getMainLocale } from './locale-store'
import { tIn } from '../shared/i18n'

/**
 * 系统通知（会话任务结束等场景）：封装 Electron Notification，统一标题格式与点击行为。
 * - 标题：会话「xxx」任务完成
 * - 正文：任务最后一条助手回复的摘要（无摘要则回退为固定文案）
 * - 点击：唤起聊天窗口 + 切换到对应会话，让用户直接看到执行结果
 * 另含会员私信 / 好友申请两类提醒（点击打开「私信」应用窗口）。
 *
 * 【i18n 期5A】三类通知的标题/正文全部走语言包，取词时机 = **通知产生的那一刻**
 *   （读 getMainLocale()，主进程唯一真相源）。所以：
 *   - 通知**不需要**语言热更新 —— 它是一次性产物，**已经弹出去的通知不会随语言变化而改变**
 *     （这是物理事实，不是缺陷；系统通知中心里的历史条目由 macOS 管，山海无从改写）。
 *   - 会话标题 / 会员昵称是**数据**（用户起的名字、模型给的标题），不是文案，原样呈现不翻。
 *
 * 【安全红线】私信通知只是「提醒人去看」，点击通知仅打开面板，
 * 绝不会把外部消息写进任何 Agent 上下文、也不会触发任何工具执行或审批。
 */
export function notifySessionTaskComplete(sessionId: string, title: string, summary: string): void {
  const L = getMainLocale()
  const cleanTitle = title?.trim() || tIn(L, 'native.notify.sessionFallback')
  const cleanSummary = summary?.trim()
  const body = cleanSummary ? cleanSummary.slice(0, 80) : tIn(L, 'native.notify.taskCompleteBody')

  const notification = new Notification({
    title: tIn(L, 'native.notify.taskCompleteTitle', { title: cleanTitle }),
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
  const L = getMainLocale()
  const cleanFrom = fromName?.trim() || tIn(L, 'native.notify.memberFallback')
  const cleanPreview = preview?.trim()
  const body = cleanPreview ? cleanPreview.slice(0, 80) : tIn(L, 'native.notify.dmBody')
  const notification = new Notification({
    title: tIn(L, 'native.notify.dmTitle', { from: cleanFrom }),
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
  const L = getMainLocale()
  const cleanFrom = fromName?.trim() || tIn(L, 'native.notify.memberFallback')
  const notification = new Notification({
    title: tIn(L, 'native.notify.friendTitle', { from: cleanFrom }),
    body: tIn(L, 'native.notify.friendBody'),
  })
  notification.on('click', () => {
    void openApp('messages')
    onOpen?.()
  })
  notification.show()
}
