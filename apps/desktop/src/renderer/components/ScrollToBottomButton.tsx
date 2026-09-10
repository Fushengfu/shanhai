import * as React from 'react'
import { IconChevronDown } from './icons'

/**
 * 「回到最新消息」浮动按钮（聊天窗口 plugins/ChatPlugin 与会话管家窗口 supervisor/SupervisorApp 共用一份）。
 *
 * 位置 / 尺寸 / 配色 / hover 反馈此前两侧逐字段相同（200/203/204 三轮在两边各改过一遍），这里收敛为一份：
 *   position:absolute + bottom:14 + left:'50%' + translateX(-50%)（水平居中写法照抄私信面板 MemberPanel
 *   的同款「回到最新消息」按钮，不另设第三种）。
 *
 * 定位上下文由调用方提供：必须是只包住消息滚动区的 position:'relative' 定位层，
 * 这样 bottom 量的是「消息区底 === 输入区顶」，输入区高度随窗口宽度变化也不影响按钮位置。
 * 组件本身只渲染按钮，不负责显隐判定（由 useScrollToBottom 的 showScrollBottom 决定是否挂载）。
 */
export function ScrollToBottomButton({ onClick, title, label }: {
  onClick: () => void
  /** 悬停提示（既有 i18n 键 chat.plugin.scrollBottomTitle） */
  title: string
  /** 按钮文案（既有 i18n 键 chat.plugin.scrollBottom） */
  label: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        position: 'absolute',
        bottom: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 14px',
        borderRadius: 14,
        border: '1px solid var(--accent)',
        background: 'var(--bg-panel)',
        color: 'var(--accent)',
        fontSize: 13,
        cursor: 'pointer',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--tint-blue-soft)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-panel)')}
    >
      <IconChevronDown />
      {label}
    </button>
  )
}
