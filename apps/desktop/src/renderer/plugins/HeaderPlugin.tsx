import { useState } from 'react'
import { IconActivity, IconClock, IconClose, IconMaximize, IconMinimize, IconMonitor, IconMoon, IconRestore, IconSettings, IconSidebar, IconSun, IconTerminal } from '../components/icons'
import { smallIconBtn } from '../components/ui'
import { WindowControlButton } from '../components/WindowTitleBar'
import { registerSlot, AppendSlotView } from '../slots'
import { useUIContext } from '../ui-context'

/** shell.header 插件：顶栏（折叠按钮 + 标题 + 记忆/轨迹/设置入口）+ 浏览器窗口标签条（可被 selfmod 替换） */
function HeaderSlot(): React.JSX.Element {
  const ctx = useUIContext()
  const [maximized, setMaximized] = useState(false)
  const handleMinimize = (): void => {
    window.shanhai?.minimizeWindow()
  }
  const handleToggleMaximize = async (): Promise<void> => {
    const next = await window.shanhai?.toggleMaximizeWindow()
    setMaximized(next ?? false)
  }
  return (
    <>
      <header
        style={
          {
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            WebkitAppRegion: 'drag',
          } as React.CSSProperties
        }
      >
        <button onClick={() => ctx.setSidebarCollapsed((v) => !v)} title={ctx.sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} style={{ ...smallIconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <IconSidebar />
        </button>
        <div style={{ fontWeight: 600, fontSize: 14 }}>山海</div>
        <button
          onClick={() => void window.shanhai?.openApp('memory')}
          title="查看长期记忆"
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          <IconClock />
          记忆
        </button>
        <button
          onClick={() => void window.shanhai?.openApp('trace')}
          title="查看执行轨迹"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          <IconActivity />
          轨迹
        </button>
        <button
          onClick={() => void window.shanhai?.openApp('settings')}
          title="设置"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          <IconSettings />
          设置
        </button>
        <button
          onClick={() => void window.shanhai?.openApp('terminal')}
          title="打开终端"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          <IconTerminal />
          终端
        </button>
        <button
          onClick={ctx.toggleTheme}
          title={ctx.theme === 'light' ? '切换到暗色模式' : '切换到亮色模式'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          {ctx.theme === 'light' ? <IconMoon /> : <IconSun />}
        </button>
        <WindowControlButton title="最小化" onClick={handleMinimize}>
          <IconMinimize />
        </WindowControlButton>
        <WindowControlButton title={maximized ? '还原' : '最大化'} onClick={() => void handleToggleMaximize()}>
          {maximized ? <IconRestore /> : <IconMaximize />}
        </WindowControlButton>
        <WindowControlButton title="关闭窗口" onClick={() => void window.shanhai?.hideChatWindow()} danger>
          <IconClose />
        </WindowControlButton>
        {/* 追加型扩展点：agent 往顶栏右侧追加按钮/小组件（不替换核心顶栏） */}
        <AppendSlotView slot="header.actions" />
      </header>

      {/* 浏览器窗口标签条：当前会话 agent 打开的内置浏览器窗口（放聊天界面顶部，不影响窗口拖动） */}
      {ctx.browserWindows.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 } as React.CSSProperties}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <IconMonitor />
            浏览器
          </span>
          {ctx.browserWindows.map((w) => (
            <div
              key={w.appId}
              onClick={() => void ctx.showBrowserWindow(w.appId)}
              title={w.label || w.title || w.url}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-sidebar)', fontSize: 12, color: 'var(--text)', maxWidth: 240, cursor: 'pointer' }}
            >
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {w.label || w.title || w.url || w.appId}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void ctx.closeBrowserWindow(w.appId)
                }}
                title="关闭浏览器窗口"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0, lineHeight: 1, flexShrink: 0 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

registerSlot('shell.header', 'core:header', 'core', HeaderSlot)
