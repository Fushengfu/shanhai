import { useEffect, useRef, useState } from 'react'
import { DOCK_APPS, appNameOf, appDescOf } from '../apps/registry'
import { useThemeSync } from '../theme'
import { applyLocale, useLocaleSync } from '../locale'
import { t } from '../../shared/i18n'
import { useUiStore, patchUiStore } from '../store-client'
// 【任务181】Dock 三个自有槽位改用专用图标族：IconMonitor 原与「管家」同字形（用户分不清），
// IconAvatar 换成与全族同尺寸 / 同描边的头像；IconGrid 换成同口径的 2×2 网格。
import { IconDockAccount, IconDockDesktop, IconDockAppMenu } from '../components/icons'
import { PluginAppIcon } from '../components/PluginAppIcon'

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

  // 退出登录菜单（登录态下点击登录状态项弹出）
  const [authMenuOpen, setAuthMenuOpen] = useState(false)

  // 动态插件窗口应用图标（AI 自研插件 install 后【不】自动显示，由用户手动从桌面壳拖拽到 Dock 添加；点击 openApp 打开）
  const [pluginApps, setPluginApps] = useState<Array<{ appId: string; name: string }>>([])
  // 跨窗口拖拽「进行中」状态（桌面壳 PluginAppsPanel 发起 → 主进程广播 → Dock 进入可接受态）
  const [dragActive, setDragActive] = useState(false)
  useEffect(() => {
    let mounted = true
    void window.shanhai?.listDockPlugins().then((apps) => {
      if (mounted) setPluginApps(apps)
    })
    const offList = window.shanhai?.onDockPluginsChanged((apps) => setPluginApps(apps))
    const offDragStart = window.shanhai?.onPluginDragStart(() => setDragActive(true))
    const offDragEnd = window.shanhai?.onPluginDragEnd(() => setDragActive(false))
    return () => {
      mounted = false
      offList?.()
      offDragStart?.()
      offDragEnd?.()
    }
  }, [])

  // 拖放接收：拖拽进行中时，用户在 Dock 窗口内释放鼠标（mouseup）即完成添加
  useEffect(() => {
    if (!dragActive) return
    const handleMouseUp = (): void => {
      void window.shanhai?.completePluginDrag()
    }
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [dragActive])

  // 主题：订阅主进程广播，跟随聊天窗口切换（亮/暗实时同步）
  useThemeSync()
  // 语言：同上（期3 移交欠账）。Dock 是独立窗口，不订阅就永远停在挂载时那份语言
  useLocaleSync()
  // 语言（i18n 期4A）：本窗口是独立 BrowserWindow，只在挂载时 initLocale() 读一次是不够的 ——
  // 别的窗口切语言时必须靠这条广播把本窗口的取词镜像同步过来（期3 移交的欠账，照抄 App.tsx 的写法）。
  useEffect(() => {
    const off = window.shanhai?.onLocaleChange((l) => applyLocale(l))
    return off
  }, [])


  // 登录状态项点击：未登录 → 打开聊天窗口并弹出登录框；已登录 → 弹出退出登录菜单。
  const handleAuthClick = (): void => {
    if (!loggedIn) {
      patchUiStore({ loginOpen: true })
      void window.shanhai?.openApp('chat')
      return
    }
    setAuthMenuOpen((v) => !v)
  }

  // 退出登录：调主进程登出（自动关闭远程连接）+ 同步跨窗口登录态
  const handleLogout = async (): Promise<void> => {
    setAuthMenuOpen(false)
    await window.shanhai?.logout()
    patchUiStore({ loggedIn: false, username: null })
  }

  // 退出到桌面：隐藏所有山海窗口回到系统界面，应用后台运行（托盘/快捷键恢复）
  const handleExitToDesktop = (): void => {
    void window.shanhai?.exitToDesktop()
  }

  /**
   * 私信未读总数（Dock 图标红点）。
   * 走独立事件通道 member:unread（低频小数据），不进 ui:state 全量快照，避免拖慢其它窗口的快照广播。
   * 未登录时主通道不会连接、也不会有未读，红点自然为 0，无需额外判断登录态。
   */
  const [dmUnread, setDmUnread] = useState(0)
  useEffect(() => {
    void window.shanhai?.memberUnread().then((u) => setDmUnread(u?.total ?? 0))
    const off = window.shanhai?.onMemberUnread((u) => setDmUnread(u?.total ?? 0))
    return off
  }, [])

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
        {/* 应用菜单入口（靠左，类似开始菜单）：【任务187】点击只通知主进程开/关专用置顶浮层窗口，
            不再由本窗口写 ui.appMenuOpen —— 主进程是唯一写者（它切窗口可见态后把真实状态广播回来，
            本按钮的高亮据此渲染），避免「Dock 以为开着、浮层其实已关」两份真相导致「点了没反应」。 */}
        <button
          data-dock-icon
          onClick={() => void window.shanhai?.setAppMenu(!ui.appMenuOpen)}
          title={t('panels.dockAppMenuTip')}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            width: 72,
            padding: '10px 4px 8px',
            borderRadius: 14,
            border: '1px solid var(--border-soft)',
            background: ui.appMenuOpen ? 'var(--bg-panel)' : 'var(--bg-sidebar)',
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
            <IconDockAppMenu />
          </span>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{t('panels.dockApps')}</span>
        </button>

        {DOCK_APPS.map((app) => (
          <button
            key={app.id}
            data-dock-icon
            onClick={() => void window.shanhai?.openApp(app.id)}
            title={t('panels.dockAppTip', { name: appNameOf(app), desc: appDescOf(app) })}
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
              <app.Icon />
              {/* 私信未读红点：只在「私信」图标上叠加，其它图标不受影响 */}
              {app.id === 'messages' && dmUnread > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -10,
                    minWidth: 15,
                    height: 15,
                    padding: '0 3px',
                    borderRadius: 8,
                    background: 'var(--danger, #ef4444)',
                    color: '#fff',
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: '15px',
                    textAlign: 'center',
                    border: '1px solid var(--bg-sidebar)',
                  }}
                >
                  {dmUnread > 99 ? '99+' : dmUnread}
                </span>
              )}
            </span>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{appNameOf(app)}</span>
          </button>
        ))}

        {/* 动态插件窗口应用（从桌面壳拖拽添加的 Dock 固定图标，点击打开独立窗口） */}
        {pluginApps.map((app) => (
          <button
            key={`plugin-${app.appId}`}
            data-dock-icon
            onClick={() => void window.shanhai?.openApp(app.appId)}
            title={t('panels.dockPluginTip', { name: app.name })}
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
            <PluginAppIcon appId={app.appId} size={30} />
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', maxWidth: 64, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {app.name}
            </span>
          </button>
        ))}

        {/* 拖拽进行中：显示放置提示（把桌面插件图标拖到这里松手添加） */}
        {dragActive && (
          <div
            data-dock-drop
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              width: 72,
              height: 76,
              borderRadius: 14,
              border: '2px dashed var(--accent)',
              color: 'var(--accent)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'copy',
              background: 'rgba(0,0,0,0.06)',
            }}
          >
            <span style={{ fontSize: 20, lineHeight: 1 }}>{t('common.plus')}</span>
            <span>{t('panels.dockDropHere')}</span>
          </div>
        )}

        {/* 登录状态 + 登录/登出入口（一目了然是否已登录） */}
        <div style={{ width: 1, alignSelf: 'stretch', margin: '8px 2px', background: 'var(--border-soft)' }} />
        <div style={{ position: 'relative' }}>
          <button
            data-dock-icon
            onClick={() => void handleAuthClick()}
            title={loggedIn ? t('panels.dockLoggedInTip', { u: username ?? '' }) : t('panels.dockClickLogin')}
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
              <IconDockAccount />
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
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--text)',
                maxWidth: 64,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {loggedIn ? (username ?? t('panels.dockLoggedIn')) : t('panels.dockLogin')}
            </span>
          </button>

          {/* 登录态下弹出的退出登录菜单 */}
          {authMenuOpen && (
            <>
              {/* 透明遮罩：点击菜单外任意处关闭 */}
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                onClick={() => setAuthMenuOpen(false)}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 10px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 50,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: 10,
                  minWidth: 128,
                  borderRadius: 12,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-panel)',
                  boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    padding: '0 6px',
                    maxWidth: 140,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {username ?? t('panels.dockLoggedIn')}
                </div>
                <button
                  onClick={() => void handleLogout()}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: 'none',
                    cursor: 'pointer',
                    background: 'var(--tint-red)',
                    color: 'var(--danger-text)',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {t('panels.dockLogout')}
                </button>
              </div>
            </>
          )}
        </div>

        {/* 退出到桌面：隐藏所有山海窗口回到系统界面，应用后台运行 */}
        <div style={{ width: 1, alignSelf: 'stretch', margin: '8px 2px', background: 'var(--border-soft)' }} />
        <button
          data-dock-icon
          onClick={handleExitToDesktop}
          title={t('panels.dockExitTip')}
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
            <IconDockDesktop />
          </span>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', maxWidth: 64, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('panels.dockExit')}
          </span>
        </button>
      </div>
    </div>
  )
}
