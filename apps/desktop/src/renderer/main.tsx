import { createRoot } from 'react-dom/client'
import './styles/theme.css'

/**
 * 渲染进程入口（多窗口桌面系统）：按窗口类型分发不同的 React 根。
 * - desktop：桌面壳窗口（壁纸 + 应用图标 Dock）
 * - chat：聊天窗口（对话主界面，加载 App 及其 UI 插件）
 * - app：应用窗口（终端/轨迹/记忆/设置/专家/模型管理等独立插件应用）
 * 用动态 import 隔离各入口的副作用（如 App 的 UI 插件注册），避免窗口之间重复注册 slot。
 */
const container = document.getElementById('root')

async function bootstrap(): Promise<void> {
  const windowType = window.shanhai?.windowType ?? 'chat'
  if (!container) return

  if (windowType === 'desktop') {
    const { DesktopApp } = await import('./desktop/DesktopApp')
    createRoot(container).render(<DesktopApp />)
  } else if (windowType === 'dock') {
    const { DockApp } = await import('./desktop/DockApp')
    createRoot(container).render(<DockApp />)
  } else if (windowType === 'app') {
    const { AppWindow } = await import('./app/AppWindow')
    createRoot(container).render(<AppWindow appId={window.shanhai?.windowAppId ?? ''} />)
  } else if (windowType === 'supervisor') {
    const { SupervisorApp } = await import('./supervisor/SupervisorApp')
    createRoot(container).render(<SupervisorApp />)
  } else if (windowType === 'supervisor-bubble') {
    const { SupervisorBubble } = await import('./supervisor/SupervisorBubble')
    createRoot(container).render(<SupervisorBubble />)
  } else {
    const { App } = await import('./App')
    createRoot(container).render(<App />)
  }
}

void bootstrap()
