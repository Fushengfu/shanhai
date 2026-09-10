import { useEffect, useState } from 'react'
import { PluginAppIcon } from '../components/PluginAppIcon'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'
import { useThemeSync } from '../theme'

/** 与 preload listPluginApps 返回项对齐的插件应用信息 */
export interface PluginAppInfo {
  appId: string
  name: string
  icon?: string
}

/**
 * Dock 上方「应用菜单」面板（类似开始菜单 / macOS 应用菜单）。
 *
 * 【任务187·方案 P】宿主窗口从「桌面壳」换成主进程专用的 app-menu 置顶浮层（铺满 workArea 的透明窗口）：
 * 桌面壳被 keepDesktopAtBottom 永久压在山海窗口栈最底，而 app/插件窗口带 alwaysOnTop:true，
 * 面板挂在桌面壳里结构上永远盖不过它们（= 用户报的「没置顶、被挡住」）。换宿主后：
 * - 本组件仍是「透明遮罩(inset:0) + 贴 Dock 上方居中的面板」，**浮层窗口与桌面壳同为 workArea 尺寸，
 *   坐标语义完全一致，所以视觉参数一个都没改**（磨砂/网格/圆角/配色/字号/定位全原样搬）；
 * - 遮罩随面板一起搬进新窗口内，「点面板外任意处关闭」因此继续有效；
 * - 开/关的唯一写者在主进程（window:setAppMenu 同时切窗口可见态并写回 appMenuOpen），
 *   本组件与 Dock 都只调 setAppMenu，不再各自 patchUiStore，避免两份真相漂移。
 *
 * 因为现在它是独立窗口的根组件，主题必须自己订阅（原先靠 DesktopApp 的 useThemeSync 顺带生效）。
 *
 * 【任务184·③】视觉为 Win11 开始菜单语言：**磨砂底板 + 应用网格 + 分区标题**。
 * 只改视觉，不加任何功能（无搜索框 / 无「最近添加」/ 无右键菜单 / 无头像电源区）。
 * 配色一律复用山海既有 CSS 变量（--bg-panel / --bg-hover / --text* / --border-soft），
 * 磨砂用 color-mix 把既有 --bg-panel 调成半透明，**不新起一套色值**。
 */
export function AppMenuPanel(): React.JSX.Element | null {
  // 谁取词谁订阅；主题同理（本窗口是独立 BrowserWindow，不订阅就永远是亮色）
  useLocaleSync()
  useThemeSync()
  const [apps, setApps] = useState<PluginAppInfo[]>([])
  // Dock 窗口顶部距 workArea 底部的距离（用于把面板定位在 Dock 上方，紧贴 Dock 弹出）
  const [dockTop, setDockTop] = useState(132)

  useEffect(() => {
    let mounted = true
    void window.shanhai?.listPluginApps().then((list) => {
      if (mounted) setApps(list ?? [])
    })
    const off = window.shanhai?.onPluginAppsChanged((list) => setApps(list ?? []))
    void window.shanhai?.getDockTop().then((v) => {
      if (mounted && v) setDockTop(v)
    })
    return () => {
      mounted = false
      off?.()
    }
  }, [])

  const close = (): void => {
    // 交还给主进程唯一写者：它 hide 浮层窗口并把 appMenuOpen=false 广播回 Dock（Dock 高亮同步复位）
    void window.shanhai?.setAppMenu(false)
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
      {/* Dock 上方面板：Win11 开始菜单式磨砂底板（紧贴 Dock 弹出，据主进程返回的偏移量定位） */}
      <div
        style={{
          position: 'fixed',
          bottom: dockTop + 12,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minWidth: 360,
          maxWidth: 560,
          padding: '14px 16px 16px',
          borderRadius: 12,
          border: '1px solid var(--border-soft)',
          // 磨砂（云母/亚克力观感）：既有面板色按 78% 混透明 + 背景模糊，颜色仍来自既有变量
          background: 'color-mix(in srgb, var(--bg-panel) 78%, transparent)',
          backdropFilter: 'blur(28px) saturate(160%)',
          WebkitBackdropFilter: 'blur(28px) saturate(160%)',
          boxShadow: '0 16px 44px rgba(0,0,0,0.32)',
          color: 'var(--text)',
          fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
          userSelect: 'none',
        }}
      >
        {/* 分区标题（Win11「已固定」那一行的位置）：沿用既有词条，不新增文案 */}
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: 0.2,
            color: 'var(--text-secondary)',
            padding: '2px 4px 8px',
          }}
        >
          {t('panels.appMenu.title')}
        </div>
        {apps.length === 0 ? (
          <div style={{ padding: '28px 8px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            {t('panels.appMenu.empty')}
          </div>
        ) : (
          // 应用网格：Win11 是等宽列的网格（不是居中挤在一起的 flex），列数随宽度自适应
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
              gap: 4,
            }}
          >
            {apps.map((app) => (
              <button
                key={app.appId}
                onClick={() => handleLaunch(app.appId)}
                title={t('panels.appMenu.appTip', { name: app.name })}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  padding: '10px 4px 8px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  // Win11 悬停是「底板浮起一层」，不是位移；这里只做背景变化，不加 transform
                  transition: 'background 0.12s ease',
                  font: 'inherit',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg-hover)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <PluginAppIcon appId={app.appId} size={44} />
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
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
