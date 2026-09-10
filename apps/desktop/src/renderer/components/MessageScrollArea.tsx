import * as React from 'react'
import { VirtualList } from './VirtualList'

/** 消息滚动容器的公共样式（聊天窗口 ChatPlugin 与会话管家窗口 SupervisorApp 逐字段相同，含 contain:'layout'） */
export const MESSAGE_SCROLL_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: 16,
  background: 'var(--bg-sidebar)',
  contain: 'layout',
}

/**
 * 消息滚动区 = 「定位层 + VirtualList + 浮层」三件套，聊天窗口与会话管家窗口共用。
 *
 * 为什么需要定位层（position:'relative'，只包住 VirtualList）：
 *   「回到最新消息」按钮用 position:absolute 定位，包含块决定 bottom 从哪儿量。若按钮直接挂在外层
 *   （含输入区 / 状态栏的容器），bottom:158 量的是「容器底 → 上 158」，输入区一长高（窗口变窄、
 *   输入框内容换行）按钮就陷进输入区（用户报的「窗口拉小时按钮被挤到输入框里」）。
 *   定位层的底边 === 消息区底 === 输入区顶 ⇒ 输入区高度再怎么变都不影响按钮位置（纯 flex/CSS）。
 *   浮层（按钮）必须放在本层内、不能放进 VirtualList 的滚动容器（该容器带 contain:'layout' + overflow，会被裁）。
 *
 * 参数化到什么程度（两侧差异全是「数据 / 入参」，不是语义）：
 *   - flex：聊天窗口按空态给 '0 0 auto'，管家窗口恒为 1（默认值即 1）
 *   - isEmpty / empty / footer：各自的数据与空态节点
 *   - style：聊天窗口空态有一套自己的内层样式，通过本参数覆盖；默认用共用的 MESSAGE_SCROLL_STYLE
 *   - children：定位层内的浮层（「回到最新消息」按钮）
 */
export function MessageScrollArea({
  listRef,
  items,
  isEmpty = false,
  empty = null,
  footer = null,
  onScroll,
  flex = 1,
  style,
  children,
}: {
  /** 滚动容器 ref，由组件挂到滚动 div 上（调用方仍用它做吸底 scrollTop=scrollHeight 与「是否在底部」判定） */
  listRef: React.RefObject<HTMLDivElement>
  /** 按顺序构建好的块节点 */
  items: React.ReactNode[]
  isEmpty?: boolean
  empty?: React.ReactNode
  footer?: React.ReactNode
  onScroll?: () => void
  /** 定位层在父 flex 列中的 flex 值（默认 1） */
  flex?: React.CSSProperties['flex']
  /** 覆盖滚动容器样式（默认 MESSAGE_SCROLL_STYLE） */
  style?: React.CSSProperties
  /** 定位层内的浮层（如「回到最新消息」按钮） */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      style={{
        flex,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <VirtualList
        containerRef={listRef}
        items={items}
        isEmpty={isEmpty}
        empty={empty}
        footer={footer}
        onScroll={onScroll}
        style={style ?? MESSAGE_SCROLL_STYLE}
      />
      {children}
    </div>
  )
}
