import { useEffect, useState } from 'react'
import { PluginAppIcon } from '../components/PluginAppIcon'
import { patchUiStore } from '../store-client'

/** 与 preload listPluginApps 返回项对齐的插件应用信息 */
export interface PluginAppInfo {
  appId: string
  name: string
  icon?: string
}

/**
 * 顶部「应用菜单」面板（类似开始菜单 / macOS 应用菜单）。
 *
 * 挂在桌面壳窗口（DesktopApp）顶部弹出：列出所有已安装的插件应用（图标 + 名称），
 * 点击应用项 openApp 打开对应窗口并关闭面板；点击面板外遮罩或再次点 Dock 入口关闭。
 *
 * 打开/关闭状态由全局共享状态 ui.appMenuOpen 驱动（Dock 入口写、桌面壳读），跨窗口同步。
 */
export function AppMenuPanel(): React.JSX.Element | null {
  const [apps, setApps] = useState<PluginAppInfo[]>([])

  useEffect(() => {
    let mounted = true
    void window.shanhai?.listPluginApps().then((list) => {
      if (mounted) setApps(list ?? [])
    })
    const off = window.shanhai?.onPluginAppsChanged((list) => setApps(list ?? []))
    return () => {
      mounted = false
      off?.()
    }
  }, [])

  const close = (): void => {
    patchUiStore({ appMenuOpen: false })
  }

  const handleLaunch = (appId: string): void => {
    void window.shanhai?.openApp(appId)
    close()
  }

  return (
    <>
      {/* 透明遮罩：点击面板外任意处关闭 */}
      <div
        onClick={close}
        style={{ position: 'fixed', inset: 0, zIndex: 90 }}
      />
      {/* 顶部面板 */}
      <div
        style={{
          position: 'fixed',
          top: 20,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          minWidth: 320,
          maxWidth: 560,
          padding: 16,
          borderRadius: 16,
          border: '1px solid var(--border-soft)',
          background: 'var(--bg-panel)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
          color: 'var(--text)',
          fontFamily: 'system-ui, sans-serif',
          userSelect: 'none',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '0 4px 4px', borderBottom: '1px solid var(--border-soft)' }}>
          应用列表
        </div>
        {apps.length === 0 ? (
          <div style={{ padding: '16px 8px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            暂无已安装的应用
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {apps.map((app) => (
              <button
                key={app.appId}
                onClick={() => handleLaunch(app.appId)}
                title={`${app.name}（插件应用）`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  width: 88,
                  padding: '12px 4px 10px',
                  borderRadius: 14,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-sidebar)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  transition: 'transform 0.12s ease, background 0.12s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-3px)'
                  e.currentTarget.style.background = 'var(--bg-panel)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)'
                  e.currentTarget.style.background = 'var(--bg-sidebar)'
                }}
              >
                <PluginAppIcon appId={app.appId} size={44} />
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--text)',
                    maxWidth: 80,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {app.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
