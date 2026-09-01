import { useEffect, useState } from 'react'
import { PluginAppIcon } from '../components/PluginAppIcon'

/** 与 preload listPluginApps 返回项对齐的插件应用信息 */
export interface PluginAppInfo {
  appId: string
  name: string
  icon?: string
}

/**
 * 桌面壳窗口（全屏壁纸）上的「已安装插件应用」图标区：列出插件应用（图标 + 名称），
 * 点击图标 openApp 打开对应插件窗口；按住图标拖拽到 Dock 可把插件添加到 Dock（跨窗口拖放）。
 * 无已安装插件应用时返回 null（不占空间）。
 *
 * 挂在 DesktopApp 的壁纸之上（AiOrb 下方），图标悬浮显示，风格接近 macOS 桌面图标。
 */
export function PluginAppsPanel(): React.JSX.Element | null {
  const [apps, setApps] = useState<PluginAppInfo[]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)

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

  // 拖拽：mousedown 开始 → 主进程广播给 Dock；本窗口 mouseup（未拖到 Dock）= 取消；
  // 若用户在 Dock 上释放，本窗口收不到 mouseup，靠主进程 drag-end 广播清理。
  useEffect(() => {
    if (!draggingId) return
    const handleMouseUp = (): void => {
      setDraggingId(null)
      window.shanhai?.cancelPluginDrag()
    }
    const offDragEnd = window.shanhai?.onPluginDragEnd(() => setDraggingId(null))
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      offDragEnd?.()
    }
  }, [draggingId])

  if (apps.length === 0) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, justifyContent: 'center', padding: '0 32px 24px' }}>
      {apps.map((app) => (
        <button
          key={app.appId}
          onMouseDown={() => {
            setDraggingId(app.appId)
            window.shanhai?.beginPluginDrag(app.appId)
          }}
          onClick={(e) => {
            e.stopPropagation()
            void window.shanhai?.openApp(app.appId)
          }}
          title={`${app.name}（插件应用，点击打开；拖拽到 Dock 固定）`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            width: 84,
            padding: '12px 4px 10px',
            borderRadius: 14,
            border: '1px solid var(--border-soft)',
            background: 'rgba(20, 20, 28, 0.55)',
            backdropFilter: 'blur(10px)',
            color: 'var(--text)',
            cursor: 'grab',
            transition: 'transform 0.12s ease, background 0.12s ease, opacity 0.12s ease',
            opacity: draggingId === app.appId ? 0.45 : 1,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-4px)'
            e.currentTarget.style.background = 'rgba(30, 30, 42, 0.7)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)'
            e.currentTarget.style.background = 'rgba(20, 20, 28, 0.55)'
          }}
        >
          <PluginAppIcon appId={app.appId} size={44} />
          <span
            style={{
              fontSize: 11,
              color: 'var(--text)',
              maxWidth: 76,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textShadow: '0 1px 3px rgba(0,0,0,0.6)',
            }}
          >
            {app.name}
          </span>
        </button>
      ))}
    </div>
  )
}
