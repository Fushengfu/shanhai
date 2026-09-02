import { useUiStore } from '../store-client'
import { AiOrb } from '../components/AiOrb'
import { useThemeSync } from '../theme'
import { PluginAppsPanel } from '../plugins/PluginAppsPanel'
import { AppMenuPanel } from './AppMenuPanel'

/**
 * 桌面壳窗口（多窗口桌面系统的「桌面」背景层）。
 * 渲染壁纸 + 顶部登录态（纯展示）。桌面窗口 focusable:false 不抢键盘焦点，但接收鼠标事件（不穿透），
 * 点击壁纸时通过 restoreAboveDesktop 把聊天/应用窗口带回前面——避免点击穿透到 macOS 墙纸触发系统「显示桌面」。
 * 可交互的应用 Dock 已拆成独立 dock 窗口（DockApp）。
 */
export function DesktopApp(): React.JSX.Element {
  const ui = useUiStore()

  // 主题：订阅主进程广播，跟随聊天窗口切换（亮/暗实时同步）
  useThemeSync()

  // 点击桌面壁纸：把聊天/应用窗口带回前面（桌面自身不抢焦点，故不会触发系统「显示桌面」）
  const handleMouseDown = (): void => {
    void window.shanhai?.restoreAboveDesktop()
  }

  const wallpaper = ui.wallpaper ?? 'linear-gradient(135deg, var(--bg-app) 0%, var(--bg-panel) 100%)'

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        width: '100vw',
        height: '100vh',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--bg-app)',
        overflow: 'hidden',
        fontFamily: 'system-ui, sans-serif',
        userSelect: 'none',
        backgroundImage: wallpaper,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }}
    >
      {/* 顶部状态条：登录态 + 用户名（纯展示） */}
      <div
        style={{
          alignSelf: 'flex-end',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          fontSize: 12,
          color: 'var(--text-secondary)',
        }}
      >
        <span>{ui.loggedIn ? `已登录：${ui.username ?? ''}` : '未登录'}</span>
      </div>

      {/* 3D AI 动画（屏幕正中间） */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AiOrb />
      </div>

      {/* 已安装插件应用图标区（悬浮在壁纸上，点击打开插件窗口） */}
      <PluginAppsPanel />

      {/* 底部占位（应用 Dock 已拆到独立 dock 窗口） */}
      <div style={{ height: 128 }} />

      {/* 顶部应用菜单面板：Dock 入口点击（ui.appMenuOpen）后在此弹出已安装应用列表 */}
      {ui.appMenuOpen && <AppMenuPanel />}
    </div>
  )
}
