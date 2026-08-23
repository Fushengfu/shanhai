import { useEffect, useRef } from 'react'
import { APP_REGISTRY } from '../apps/registry'
import { useThemeSync } from '../theme'

/**
 * Dock 窗口（多窗口桌面系统的底部应用图标栏）。
 * 独立于桌面壳窗口：桌面壳忽略鼠标（点击穿透，永不提升），Dock 栏则保持可点击，
 * 点击图标 openApp 打开对应独立应用窗口；点击图标之外的空隙时 restoreAboveDesktop 把聊天窗口带回。
 */
export function DockApp(): React.JSX.Element {
  const dockRef = useRef<HTMLDivElement>(null)

  // 主题：订阅主进程广播，跟随聊天窗口切换（亮/暗实时同步）
  useThemeSync()

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
        background: 'transparent',
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
      </div>
    </div>
  )
}
