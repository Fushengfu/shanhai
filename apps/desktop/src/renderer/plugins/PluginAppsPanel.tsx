import { useEffect, useRef, useState } from 'react'
import { PluginAppIcon } from '../components/PluginAppIcon'

/** 与 preload listPluginApps 返回项对齐的插件应用信息 */
export interface PluginAppInfo {
  appId: string
  name: string
  icon?: string
}

interface Position {
  x: number
  y: number
}

/** 单次拖拽的运行时状态（存 ref，避免触发重渲染） */
interface DragState {
  appId: string
  startX: number
  startY: number
  originX: number
  originY: number
  curX: number
  curY: number
  moved: boolean
}

/** 桌面插件图标位置持久化键（localStorage，与 shanhai-theme 同机制，重启后恢复） */
const POSITIONS_KEY = 'shanhai-desktop-plugin-positions'
/** 拖拽阈值（px）：指针偏移超过该值才判定为「拖拽」，否则视为「点击打开」 */
const DRAG_THRESHOLD = 4
/** 卡片近似尺寸（用于 clamp 到桌面可视区内，避免拖出屏幕） */
const CARD_W = 84
const CARD_H = 104
/** 默认网格布局（无历史位置时，按索引自动摆放） */
const GRID_COLS = 5

function loadPositions(): Record<string, Position> {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Position>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function savePosition(appId: string, pos: Position): void {
  try {
    const all = loadPositions()
    all[appId] = pos
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(all))
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

/**
 * 桌面壳窗口（全屏壁纸）上的「已安装插件应用」图标区。
 *
 * - 卡片可在桌面画布内【自由拖拽】摆放，松手停在任意位置，位置持久化（restart 后恢复）；
 * - 点击（无拖拽，指针偏移 < 阈值）打开对应插件窗口；
 * - 拖拽超阈值后仍可通过把图标拖到 Dock 窗口释放来「固定到 Dock」（复用 beginPluginDrag 广播）；
 * - 卡片背景透明：图标 + 名称直接贴在壁纸上（名称带文字阴影保证可读），不再有实色卡片遮挡。
 *
 * 挂在 DesktopApp 全屏 overlay 上（absolute + inset:0 + pointerEvents:none），
 * 卡片自身 pointerEvents:auto，点击空白壁纸仍能透传到桌面壳的 restoreAboveDesktop。
 */
export function PluginAppsPanel(): React.JSX.Element | null {
  const [apps, setApps] = useState<PluginAppInfo[]>([])
  const [positions, setPositions] = useState<Record<string, Position>>(() => loadPositions())
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

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

  // 跨窗口拖拽结束广播清理：拖到 Dock 释放时桌面窗口收不到 mouseup，靠主进程 drag-end 广播清理
  useEffect(() => {
    const off = window.shanhai?.onPluginDragEnd(() => {
      dragRef.current = null
      setDraggingId(null)
    })
    return () => off?.()
  }, [])

  // 拖拽：document 级 mousemove / mouseup（dragRef 为空即无拖拽，直接 return）
  useEffect(() => {
    const handleMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      if (!d.moved) {
        d.moved = true
        // 通知 Dock 进入可接受态：若拖到 Dock 释放则固定，否则桌面内自由摆放
        window.shanhai?.beginPluginDrag(d.appId)
        setDraggingId(d.appId)
      }
      const cw = containerRef.current?.clientWidth ?? window.innerWidth
      const ch = containerRef.current?.clientHeight ?? window.innerHeight
      d.curX = Math.min(Math.max(0, d.originX + dx), cw - CARD_W)
      d.curY = Math.min(Math.max(0, d.originY + dy), ch - CARD_H)
      setPositions((prev) => ({ ...prev, [d.appId]: { x: d.curX, y: d.curY } }))
    }
    const handleUp = (): void => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      if (d.moved) {
        savePosition(d.appId, { x: d.curX, y: d.curY })
        setDraggingId(null)
        window.shanhai?.cancelPluginDrag() // 非 Dock 释放：结束拖拽态
      } else {
        window.shanhai?.openApp(d.appId) // 未移动：点击打开
      }
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [])

  if (apps.length === 0) return null

  const defaultPosition = (i: number): Position => ({
    x: 48 + (i % GRID_COLS) * 108,
    y: 40 + Math.floor(i / GRID_COLS) * 120,
  })

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 10,
        overflow: 'hidden',
      }}
    >
      {apps.map((app, i) => {
        const pos = positions[app.appId] ?? defaultPosition(i)
        const dragging = draggingId === app.appId
        return (
          <button
            key={app.appId}
            onMouseDown={(e) => {
              e.stopPropagation()
              dragRef.current = {
                appId: app.appId,
                startX: e.clientX,
                startY: e.clientY,
                originX: pos.x,
                originY: pos.y,
                curX: pos.x,
                curY: pos.y,
                moved: false,
              }
            }}
            title={`${app.name}（插件应用，点击打开；拖拽到任意位置摆放，拖到 Dock 固定）`}
            style={{
              position: 'absolute',
              left: pos.x,
              top: pos.y,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              width: CARD_W,
              padding: '12px 4px 10px',
              border: 'none',
              background: 'transparent',
              color: 'var(--text)',
              cursor: dragging ? 'grabbing' : 'grab',
              pointerEvents: 'auto',
              opacity: dragging ? 0.5 : 1,
              transition: dragging ? 'none' : 'opacity 0.12s ease, transform 0.12s ease',
              userSelect: 'none',
            }}
            onMouseEnter={(e) => {
              if (!dragRef.current) e.currentTarget.style.transform = 'scale(1.06)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)'
            }}
          >
            <PluginAppIcon appId={app.appId} size={44} />
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text)',
                maxWidth: 76,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textShadow: '0 1px 2px rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.25)',
              }}
            >
              {app.name}
            </span>
          </button>
        )
      })}
    </div>
  )
}