import { useEffect, useRef, useState } from 'react'
import { PluginAppIcon } from '../components/PluginAppIcon'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'
import { useUiStore } from '../store-client'
import {
  buildTitleStyles,
  estimateWallpaperLuminance,
  pickTitleScheme,
  CHIP_PADDING,
  CHIP_RADIUS,
} from '../wallpaper-contrast'

/** 与 preload listPluginApps 返回项对齐的插件应用信息 */
export interface PluginAppInfo {
  appId: string
  name: string
  icon?: string
}

/** 单次拖拽的运行时状态（存 ref，避免触发重渲染）。
 * 任务163：只保留「拖拽意图判定」（用于拖到 Dock 固定），不再有自由摆放坐标——图标按注册顺序流式排布。 */
interface DragState {
  appId: string
  startX: number
  startY: number
  moved: boolean
}

/** 拖拽阈值（px）：指针偏移超过该值才判定为「拖拽」，否则视为「点击打开」 */
const DRAG_THRESHOLD = 4
/** 卡片宽度（与原网格单项占位一致，保持视觉不变） */
const CARD_W = 84
/**
 * 布局起点与间距：复刻原默认网格（起点 48,40；列步长 108 = 84 宽 + 24 间隙；行步长 120 ≈ 104 高 + 16 间隙）。
 * 任务163：图标改为【按注册顺序流式排布（flex-wrap 换行）】，不再自由摆放——
 * 原 absolute 自由坐标与「按索引计算的默认槽位」是两套坐标系，新装插件的默认槽位会压到
 * 用户已拖拽保存的旧坐标上（实测 angry-birds 默认槽 (156,40) 与 billiards 存档位 (157,41) 几乎完全重叠），
 * 且拖拽落点无碰撞检测（实测存档里 fruit-ninja (143,181) 与 cap-browser-test (156,173) 重叠 71×96px）。
 */
const GRID_PADDING = '40px 48px'
const GRID_GAP = '16px 24px'

/**
 * 桌面壳窗口（全屏壁纸）上的「已安装插件应用」图标区。
 *
 * - 图标【按注册顺序依次排布，flex-wrap 换行，彼此不重叠】（任务163：去掉自由摆放，重叠根因即自由坐标）；
 * - 点击（无拖拽，指针偏移 < 阈值）打开对应插件窗口；
 * - 按住拖拽超阈值后仍可通过把图标拖到 Dock 窗口释放来「固定到 Dock」（复用 beginPluginDrag 广播）；
 * - 卡片背景透明：图标直接贴在壁纸上；标题不再依赖"某一个固定色"，而是走
 *   半透明底板 + 随壁纸亮度翻转的文字色（见 wallpaper-contrast.ts，任务188）。
 *
 * 挂在 DesktopApp 全屏 overlay 上（absolute + inset:0 + pointerEvents:none），
 * 卡片自身 pointerEvents:auto，点击空白壁纸仍能透传到桌面壳的 restoreAboveDesktop。
 */
export function PluginAppsPanel(): React.JSX.Element | null {
  // 谁取词谁订阅（title 属性在渲染期求值）
  useLocaleSync()
  const [apps, setApps] = useState<PluginAppInfo[]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // 壁纸亮度（null=估不出来，走兜底档）。订阅 ui.wallpaper：换壁纸即时重算
  const ui = useUiStore()
  const [wallpaperLum, setWallpaperLum] = useState<number | null>(null)

  const dragRef = useRef<DragState | null>(null)

  // 标题配色档：亮度未知 → 兜底（主题同向底板），已知 → 随壁纸翻转
  const titleStyles = buildTitleStyles(pickTitleScheme(wallpaperLum))

  useEffect(() => {
    let cancelled = false
    void estimateWallpaperLuminance(ui.wallpaper).then((lum) => {
      if (!cancelled) setWallpaperLum(lum)
    })
    return () => {
      cancelled = true
    }
  }, [ui.wallpaper])

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

  // 拖拽意图判定：document 级 mousemove / mouseup（dragRef 为空即无拖拽，直接 return）。
  // 任务163：拖拽不再移动图标（自由摆放是重叠根因），超阈值仅用于「拖到 Dock 固定」链路。
  useEffect(() => {
    const handleMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      if (!d.moved) {
        d.moved = true
        // 通知 Dock 进入可接受态：拖到 Dock 释放则固定该图标
        window.shanhai?.beginPluginDrag(d.appId)
        setDraggingId(d.appId)
      }
    }
    const handleUp = (): void => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      if (d.moved) {
        setDraggingId(null)
        window.shanhai?.cancelPluginDrag() // 非 Dock 释放：结束拖拽态（图标留在原位，不产生自由坐标）
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

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 10,
        overflow: 'hidden',
        // 任务163：顺序流式布局——按注册（listPluginApps 返回序）依次排布，放不下自动换行，杜绝重叠
        display: 'flex',
        flexWrap: 'wrap',
        alignContent: 'flex-start',
        justifyContent: 'flex-start',
        padding: GRID_PADDING,
        gap: GRID_GAP,
      }}
    >
      {apps.map((app) => {
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
                moved: false,
              }
            }}
            title={t('panels.pluginApps.appTip', { name: app.name })}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              width: CARD_W,
              flexShrink: 0,
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
            {/* 标题可读性（任务188）：底板与文字色由 wallpaper-contrast 按壁纸亮度选档；
                估不出亮度时自动退回「主题同向底板」档，不存在"换某张壁纸就看不清"的档位。 */}
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                maxWidth: 76,
                boxSizing: 'border-box',
                padding: CHIP_PADDING,
                borderRadius: CHIP_RADIUS,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                ...titleStyles,
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