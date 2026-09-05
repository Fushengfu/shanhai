import { useState } from 'react'
import { IconActivity, IconClock, IconClose, IconMaximize, IconMinimize, IconMonitor, IconMoon, IconRestore, IconSettings, IconSidebar, IconSun, IconTerminal } from '../components/icons'
import { smallIconBtn } from '../components/ui'
import { WindowControlButton } from '../components/WindowTitleBar'
import { DmEntryButton } from '../components/DmEntryButton'
import { registerSlot, AppendSlotView } from '../slots'
import { useUIContext } from '../ui-context'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

/** shell.header 插件：顶栏（折叠按钮 + 标题 + 记忆/轨迹/设置入口）+ 浏览器窗口标签条（可被 selfmod 替换） */
function HeaderSlot(): React.JSX.Element {
  const ctx = useUIContext()
  // 谁取词谁订阅：顶栏全部 tooltip / 标签在渲染期取词
  useLocaleSync()
  const [maximized, setMaximized] = useState(false)
  const handleMinimize = (): void => {
    window.shanhai?.minimizeWindow()
  }
  const handleToggleMaximize = async (): Promise<void> => {
    const next = await window.shanhai?.toggleMaximizeWindow()
    setMaximized(next ?? false)
  }
  // 私信入口（含未读/好友申请红点）收敛到共用组件 DmEntryButton：
  // 管家窗口顶栏用的是同一个组件、同一真值源（member:unread / member:friends 广播），此处不再各算一套。
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
        <button onClick={() => ctx.setSidebarCollapsed((v) => !v)} title={ctx.sidebarCollapsed ? t('panels.header.sidebarExpand') : t('panels.header.sidebarCollapse')} style={{ ...smallIconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <IconSidebar />
        </button>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{t('chat.brand')}</div>
        <DmEntryButton loggedIn={ctx.loggedIn} labeled style={{ marginLeft: 'auto' }} />
        <button
          onClick={() => void window.shanhai?.openApp('memory')}
          title={t('panels.header.memoryTip')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          <IconClock />
          {t('app.memory.name')}
        </button>
        <button
          onClick={() => void window.shanhai?.openApp('trace')}
          title={t('panels.header.traceTip')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          <IconActivity />
          {t('app.trace.name')}
        </button>
        <button
          onClick={() => void window.shanhai?.openApp('settings')}
          title={t('app.settings.name')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          <IconSettings />
          {t('app.settings.name')}
        </button>
        <button
          onClick={() => void window.shanhai?.openApp('terminal')}
          title={t('panels.header.terminalTip')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          <IconTerminal />
          {t('app.terminal.name')}
        </button>
        <button
          onClick={ctx.toggleTheme}
          title={ctx.theme === 'light' ? t('common.themeToDark') : t('common.themeToLight')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
        >
          {ctx.theme === 'light' ? <IconMoon /> : <IconSun />}
        </button>
        <WindowControlButton title={t('common.winMinimize')} onClick={handleMinimize}>
          <IconMinimize />
        </WindowControlButton>
        <WindowControlButton title={maximized ? t('common.winRestore') : t('common.winMaximize')} onClick={() => void handleToggleMaximize()}>
          {maximized ? <IconRestore /> : <IconMaximize />}
        </WindowControlButton>
        <WindowControlButton title={t('panels.header.closeWindow')} onClick={() => void window.shanhai?.hideChatWindow()} danger>
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
            {t('panels.header.browser')}
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
                title={t('panels.header.closeBrowser')}
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
