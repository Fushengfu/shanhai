import { createRoot } from 'react-dom/client'
import { UpdateProgressOverlay } from './components/UpdateProgressOverlay'
import './styles/theme.css'

/**
 * 渲染进程入口（多窗口桌面系统）：按窗口类型分发不同的 React 根。
 * - desktop：桌面壳窗口（壁纸 + 应用图标 Dock）
 * - chat：聊天窗口（对话主界面，加载 App 及其 UI 插件）
 * - app：应用窗口（终端/轨迹/记忆/设置/模型管理等独立插件应用）
 * 用动态 import 隔离各入口的副作用（如 App 的 UI 插件注册），避免窗口之间重复注册 slot。
 *
 * 内容类窗口（chat / supervisor / app）额外统一挂一个「更新下载进度浮层」：
 * 主进程把进度广播到所有窗口，用户在任意内容窗口都能看到同一份进度；
 * 桌面壳（全屏壁纸层、忽略鼠标）与 Dock（细长图标条）不挂，避免层级/尺寸干扰。
 */
const container = document.getElementById('root')

/** 需要挂更新进度浮层的窗口类型 */
const PROGRESS_OVERLAY_WINDOWS = new Set(['chat', 'app', 'supervisor'])

async function bootstrap(): Promise<void> {
  const windowType = window.shanhai?.windowType ?? 'chat'
  if (!container) return

  // 平台 + 圆角标记：供 theme.css 做 Windows 窗口圆角裁剪。
  // 所有窗口类型在 Windows 上都圆角（desktop/dock/supervisor-bubble 在 Windows 下也已设 transparent，统一走 CSS 圆角）。
  // 圆角规则只在 data-platform='win32' 时生效；macOS 的 frameless 窗口有系统原生圆角，不受影响。
  document.documentElement.dataset.platform = window.shanhai?.platform ?? ''
  document.documentElement.dataset.rounded = 'true'
  // 窗口类型标记：供 theme.css 按窗口类型做差异化（如 chat/supervisor/app 内容窗口加可见描边，桌面壳/Dock/悬浮图标不加）
  document.documentElement.dataset.window = windowType

  const withProgress = PROGRESS_OVERLAY_WINDOWS.has(windowType)
  const root = createRoot(container)
  const mount = async (node: React.JSX.Element): Promise<void> => {
    if (!withProgress) {
      root.render(node)
      return
    }
    root.render(
      <>
        {node}
        <UpdateProgressOverlay />
      </>,
    )
  }

  if (windowType === 'desktop') {
    const { DesktopApp } = await import('./desktop/DesktopApp')
    await mount(<DesktopApp />)
  } else if (windowType === 'dock') {
    const { DockApp } = await import('./desktop/DockApp')
    await mount(<DockApp />)
  } else if (windowType === 'app') {
    const { AppWindow } = await import('./app/AppWindow')
    await mount(<AppWindow appId={window.shanhai?.windowAppId ?? ''} />)
  } else if (windowType === 'supervisor') {
    const { SupervisorApp } = await import('./supervisor/SupervisorApp')
    await mount(<SupervisorApp />)
  } else if (windowType === 'supervisor-bubble') {
    const { SupervisorBubble } = await import('./supervisor/SupervisorBubble')
    await mount(<SupervisorBubble />)
  } else {
    const { App } = await import('./App')
    await mount(<App />)
  }
}

void bootstrap()
