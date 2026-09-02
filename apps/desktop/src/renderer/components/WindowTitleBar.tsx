import type { ReactNode } from 'react'
import { useState } from 'react'
import * as React from 'react'
import { IconClose, IconMaximize, IconMinimize, IconRestore } from './icons'
import { smallIconBtn } from './ui'

/** 标题栏窗口控制按钮（最小化/最大化/关闭），对齐文件管理器插件标准：36×36、圆角 8、关闭键 hover 红色 */
export function WindowControlButton(props: { title: string; onClick: () => void; children: ReactNode; danger?: boolean }): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      style={
        {
          ...smallIconBtn,
          color: 'var(--titlebar-btn-color)',
          width: 36,
          height: 36,
          padding: 0,
          borderRadius: 8,
          flexShrink: 0,
          ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties),
        } as React.CSSProperties
      }
      onMouseEnter={(e) => {
        if (props.danger) {
          e.currentTarget.style.background = 'var(--titlebar-btn-danger)'
          e.currentTarget.style.color = '#fff'
        } else {
          e.currentTarget.style.background = 'var(--titlebar-btn-hover-bg)'
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--titlebar-btn-color)'
      }}
    >
      {props.children}
    </button>
  )
}

/**
 * 应用窗口统一标题栏（多窗口桌面系统的 app 窗口）。
 * 整条标题栏可拖动窗口（-webkit-app-region: drag），左侧图标 + 标题 + 副标题，右侧操作按钮 + 自定义窗口控制按钮（no-drag）。
 * 窗口控制按钮统一为「最小化 / 最大化(还原) / 关闭」，替代 macOS 系统红绿灯（titleBarStyle:'hidden'）。
 */
export const WindowTitleBar = React.memo(function WindowTitleBar(props: {
  icon?: ReactNode
  title: string
  subtitle?: string
  /** 图标色调：accent（蓝，默认）/ purple（紫，用于记忆等个别应用） */
  tone?: 'accent' | 'purple'
  /** 标题区右侧的额外内容（如计数 badge） */
  extra?: ReactNode
  /** 右侧操作按钮区（在窗口控制按钮左侧） */
  actions?: ReactNode
  onClose?: () => void
}): React.JSX.Element {
  const toneBg = props.tone === 'purple' ? 'var(--tint-purple)' : 'var(--tint-blue-soft)'
  const toneColor = props.tone === 'purple' ? 'var(--purple)' : 'var(--accent)'
  const [maximized, setMaximized] = useState(false)

  const handleMinimize = (): void => {
    window.shanhai?.minimizeWindow()
  }
  const handleToggleMaximize = async (): Promise<void> => {
    const next = await window.shanhai?.toggleMaximizeWindow()
    setMaximized(next ?? false)
  }

  return (
    <div
      style={
        {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-subtle)',
          flexShrink: 0,
          userSelect: 'none',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
    >
      {props.icon && (
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: toneBg,
            color: toneColor,
            flexShrink: 0,
          }}
        >
          {props.icon}
        </span>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)', lineHeight: 1.2 }}>{props.title}</div>
        {props.subtitle && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{props.subtitle}</div>}
      </div>
      {props.extra}
      <div style={{ flex: 1 }} />
      {props.actions && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}>
          {props.actions}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}>
        <WindowControlButton title="最小化" onClick={handleMinimize}>
          <IconMinimize />
        </WindowControlButton>
        <WindowControlButton title={maximized ? '还原' : '最大化'} onClick={() => void handleToggleMaximize()}>
          {maximized ? <IconRestore /> : <IconMaximize />}
        </WindowControlButton>
        {props.onClose && (
          <WindowControlButton title="关闭" onClick={props.onClose} danger>
            <IconClose />
          </WindowControlButton>
        )}
      </div>
    </div>
  )
})
