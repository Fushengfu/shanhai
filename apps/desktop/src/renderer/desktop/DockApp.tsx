import { useEffect, useRef } from 'react'
import { APP_REGISTRY } from '../apps/registry'
import { useThemeSync } from '../theme'
import { useUiStore, patchUiStore } from '../store-client'
import { IconAvatar, IconMonitor } from '../components/icons'

/**
 * Dock 窗口（多窗口桌面系统的底部应用图标栏）。
 * 独立于桌面壳窗口：桌面壳忽略鼠标（点击穿透，永不提升），Dock 栏则保持可点击，
 * 点击图标 openApp 打开对应独立应用窗口；点击图标之外的空隙时 restoreAboveDesktop 把聊天窗口带回。
 */
export function DockApp(): React.JSX.Element {
  const dockRef = useRef<HTMLDivElement>(null)

  // 登录态（共享 store：主进程广播，跨窗口一致）
  const ui = useUiStore()
  const loggedIn = ui.loggedIn
  const username = ui.username

  // 主题：订阅主进程广播，跟随聊天窗口切换（亮/暗实时同步）
  useThemeSync()

  // 登录状态项点击：未登录 → 打开聊天窗口并弹出登录框；已登录 → 打开聊天窗口（进入主界面）。
  // 已登录时【不再】在此退出登录：登录状态项是「状态展示 + 入口」，点击即退出会误触；退出登录入口保留在聊天窗口侧边栏。
  const handleAuthClick = (): void => {
    if (!loggedIn) {
      patchUiStore({ loginOpen: true })
    }
    void window.shanhai?.openApp('chat')
  }

  // 退出到桌面：隐藏所有山海窗口回到系统界面，应用后台运行（托盘/快捷键恢复）
  const handleExitToDesktop = (): void => {
    void window.shanhai?.exitToDesktop()
  }

  // 自适应：测量图标栏实际内容尺寸，通知主进程调整 Dock 窗口宽高（随应用数量增减自动伸缩）
  useEffect(() => {
    const el = dockRef.current
    if (!el) return
    const measure = (): void => {
      const w = el.scrollWidth + 24 // 左右各留 12 空隙
      const h = el.scrollHeight + 16 // 上下各留 8 空隙
      void window.shanhai?.resizeDock(w, h)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleMouseDown = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    // 点击图标不干预（让 openApp 正常派发）；点击 Dock 空隙把聊天窗口带回
    if (target.closest('[data-dock-icon]')) return
    void window.shanhai?.restoreAboveDesktop()
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 浅灰底板：macOS 上靠 body 的 --bg-app 垫底，Windows 上 body 被圆角规则透明化，
        // 这里显式给 Dock 容器补上 --bg-app，使两端观感一致（Windows 不再纯透明悬浮）。
        background: 'var(--bg-app)',
        borderRadius: 16,
        overflow: 'hidden',
        fontFamily: 'system-ui, sans-serif',
        userSelect: 'none',
      }}
    >
      <div
        ref={dockRef}
        data-dock
        style={{
          display: 'flex',
          gap: 10,
          flexShrink: 0,
          width: 'max-content',
        }}
      >
        {APP_REGISTRY.map((app) => (
          <button
            key={app.id}
            data-dock-icon
            onClick={() => void window.shanhai?.openApp(app.id)}
            title={`${app.name}（${app.description}）`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              width: 72,
              padding: '10px 4px 8px',
              borderRadius: 14,
              border: '1px solid var(--border-soft)',
              background: 'var(--bg-sidebar)',
              color: 'var(--text)',
              cursor: 'pointer',
              transition: 'transform 0.12s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-4px)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
            }}
          >
            <span style={{ transform: 'scale(1.6)', display: 'inline-flex' }}>
              <app.Icon />
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{app.name}</span>
          </button>
        ))}

        {/* 登录状态 + 登录/登出入口（一目了然是否已登录） */}
        <div style={{ width: 1, alignSelf: 'stretch', margin: '8px 2px', background: 'var(--border-soft)' }} />
        <button
          data-dock-icon
          onClick={() => void handleAuthClick()}
          title={loggedIn ? `已登录：${username ?? ''}（点击打开聊天窗口）` : '点击登录'}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            width: 72,
            padding: '10px 4px 8px',
            borderRadius: 14,
            border: '1px solid var(--border-soft)',
            background: 'var(--bg-sidebar)',
            color: 'var(--text)',
            cursor: 'pointer',
            transition: 'transform 0.12s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-4px)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)'
          }}
        >
          <span style={{ position: 'relative', display: 'inline-flex', transform: 'scale(1.6)' }}>
            <IconAvatar />
            <span
              style={{
                position: 'absolute',
                right: -2,
                bottom: -2,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: loggedIn ? 'var(--success-text)' : 'var(--text-faint)',
                border: '1.5px solid var(--bg-sidebar)',
              }}
            />
          </span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-secondary)',
              maxWidth: 64,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {loggedIn ? (username ?? '已登录') : '登录'}
          </span>
        </button>

        {/* 退出到桌面：隐藏所有山海窗口回到系统界面，应用后台运行 */}
        <div style={{ width: 1, alignSelf: 'stretch', margin: '8px 2px', background: 'var(--border-soft)' }} />
        <button
          data-dock-icon
          onClick={handleExitToDesktop}
          title="退出到桌面（隐藏山海所有窗口，回到系统界面，后台运行）"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            width: 72,
            padding: '10px 4px 8px',
            borderRadius: 14,
            border: '1px solid var(--border-soft)',
            background: 'var(--bg-sidebar)',
            color: 'var(--text)',
            cursor: 'pointer',
            transition: 'transform 0.12s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-4px)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)'
          }}
        >
          <span style={{ transform: 'scale(1.6)', display: 'inline-flex' }}>
            <IconMonitor />
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 64, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            回桌面
          </span>
        </button>
      </div>
    </div>
  )
}
