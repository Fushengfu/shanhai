import { app, Menu } from 'electron'
import { listPluginApps } from './plugin-apps'
import { showChatWindow, openApp } from './window-manager'

/**
 * macOS Dock 菜单：右键/点击 Dock 上的山海图标弹出菜单，
 * 列出「打开主窗口」+ 已安装插件应用列表（点某项打开对应插件窗口）+ 退出。
 *
 * 插件安装/卸载时由 push.ts 调 refreshDockMenu 刷新（菜单项动态更新）。
 * 非 macOS（app.dock 不存在）或应用未就绪时为 no-op。
 */
export function refreshDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock || !app.isReady()) return
  try {
    const plugins = listPluginApps()
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: '打开主窗口', click: () => showChatWindow() },
    ]
    if (plugins.length > 0) {
      template.push({ type: 'separator' })
      for (const p of plugins) {
        template.push({
          label: p.name,
          click: () => void openApp(p.appId),
        })
      }
    }
    template.push({ type: 'separator' })
    template.push({ label: '退出山海', click: () => app.quit() })
    app.dock.setMenu(Menu.buildFromTemplate(template))
  } catch (err) {
    console.warn('[山海] 设置 Dock 菜单失败：', err)
  }
}
