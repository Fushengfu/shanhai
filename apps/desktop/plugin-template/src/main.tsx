import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

/**
 * 插件窗口独立渲染入口（第 2 步）。
 *
 * 这是「插件应用模板」的入口：主进程 openApp 检测到插件编译产物（dist/client.html）后，
 * 用 loadFile 加载本页面（而非 renderer/index.html → AppWindow → new Function）。
 * 因此插件可以用完整 React + JSX + 任意依赖开发复杂界面，并通过 window.shanhaiPlugin
 * （插件专用 preload 暴露的白名单桥）调用山海公开接口。
 *
 * 注意：本入口跑在独立 app 渲染进程、挂的是插件专用 preload（plugin.cjs），
 * 只能访问 window.shanhaiPlugin（白名单）与 window.shanhai（宿主桥，仅 getPluginApp/closeApp），
 * 没有 chat 窗口的 useUIContext / SlotRegistry，也拿不到全量 window.shanhai。
 */
const container = document.getElementById('root')
if (container) {
  createRoot(container).render(<App />)
}
