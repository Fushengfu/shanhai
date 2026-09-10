import { useCallback, useRef, useState } from 'react'
import type * as React from 'react'

/**
 * 消息列表「是否在底部」判定 + 「回到最新消息」按钮的显隐与滚底动作。
 *
 * 聊天窗口（plugins/ChatPlugin）与会话管家窗口（supervisor/SupervisorApp）此前各写一份完全相同的
 * 判定式与按钮态镜像，本 hook 收敛为一份（阈值 120 一字未改、滚底写法与既有两处一致）。
 *
 * 明确**不并入**本 hook 的两件事（两侧「有意不同」，合并会改掉其一的行为）：
 *   1. 吸底跟随 effect：聊天窗口 deps=[cur.items, streaming.text, streaming.reasoning, curApproval]；
 *      管家窗口 deps=[cur.items, streamedText(120ms 节流), curApproval]（自陈为避免 rAF 期间每帧同步 reflow）。
 *      ⇒ 两个跟随 effect 留在各自调用方，用本 hook 返回的 atBottomRef 做 gate。
 *   2. 切换会话重置：只有聊天窗口有会话可切。聊天窗口沿用本 hook 的 resetToBottom() 复现原两行。
 */
export function useScrollToBottom(listRef: React.RefObject<HTMLDivElement>): {
  /** 用户是否在底部：仅由滚动事件维护，不参与「内容增长」计算（流式一次性增长超过阈值会被误判为已上翻）。 */
  atBottomRef: React.MutableRefObject<boolean>
  /** 「回到最新消息」按钮显隐：atBottomRef 不触发重渲染，另存一份可触发渲染的镜像（同一份判定，不引入第二套真相）。 */
  showScrollBottom: boolean
  /** 滚动事件回调：更新 atBottomRef + 同步按钮显隐 */
  handleScroll: () => void
  /** 点击「回到最新消息」：滚到底并收起按钮 */
  handleScrollToBottom: () => void
  /** 仅重置「在底部」标记与按钮态（不含滚动定位，调用方按需自行滚到底） */
  resetToBottom: () => void
} {
  const atBottomRef = useRef(true)
  const [showScrollBottom, setShowScrollBottom] = useState(false)

  const handleScroll = useCallback((): void => {
    const el = listRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    atBottomRef.current = atBottom
    setShowScrollBottom(!atBottom)
  }, [listRef])

  const handleScrollToBottom = useCallback((): void => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowScrollBottom(false)
  }, [listRef])

  const resetToBottom = useCallback((): void => {
    atBottomRef.current = true
    setShowScrollBottom(false)
  }, [])

  return { atBottomRef, showScrollBottom, handleScroll, handleScrollToBottom, resetToBottom }
}
