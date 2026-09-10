import type { ChatItem, SessionUIState } from '../types'
import { t } from '../../shared/i18n'

/**
 * 通用错误气泡（聊天窗口 App.tsx 6 个站点 + 会话管家窗口 SupervisorApp.tsx 3 个站点 = 9 处共用一份）。
 *
 * 覆盖范围**仅限**「把一次失败渲染成会话流里的一条 assistant 助手气泡」这件事本身
 * （形状 + i18n 前缀 chat.shell.errorPrefix）。以下两点是两侧（甚至同侧不同站点）**有意不同**的，
 * 一律由调用方传入、不在此处统一：
 *   - 失败文案的取法：聊天窗口各站点用 String(err)；管家窗口用 err instanceof Error ? err.message : String(err)。
 *     二者对 Error 实例的结果不同（'Error: x' vs 'x'），统一会改变现有输出 ⇒ 由调用方算好 msg 传进来。
 *   - turnSeq / turnDuration：有的站点带（633 / 483 / 510 / 606），有的不带（824 / 848 / 867 / 887 / 960），
 *     且计算基准不同（s.items  vs  主进程重建后的 base）⇒ 由调用方算好传进来；不传则字段不出现（与原来一致）。
 * ⚠️ 明确不含管家的 stopNotice 停止反馈横幅：那是「用本地 state 而非塞 items」的有意设计
 *    （items 会被 onSessionActivity('end') 重建抹掉），本助手不参与、不替代。
 */
export function appendErrorBubble(
  items: ChatItem[],
  msg: string,
  opts: { turnSeq?: number; turnDuration?: number } = {},
): ChatItem[] {
  const bubble: ChatItem = {
    kind: 'assistant',
    content: t('chat.shell.errorPrefix', { msg }),
  }
  if (opts.turnSeq !== undefined) bubble.turnSeq = opts.turnSeq
  if (opts.turnDuration !== undefined) bubble.turnDuration = opts.turnDuration
  return [...items, bubble]
}

/**
 * 错误后复位流式态的公共补丁片段（streaming / streamingReasoning 清空 + busy=false）。
 * 聊天窗口 4 处 + 管家窗口 2 处原本各写一遍同样的三个字段，这里收敛为一份常量（展开使用，值完全一致）。
 */
export const ERROR_RESET_STATE: Pick<SessionUIState, 'streaming' | 'streamingReasoning' | 'busy'> = {
  streaming: '',
  streamingReasoning: '',
  busy: false,
}
