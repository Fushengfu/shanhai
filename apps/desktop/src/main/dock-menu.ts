import { app, Menu } from 'electron'
import { listPluginApps } from './plugin-apps'
import { showChatWindow, openApp } from './window-manager'
import { getMainLocale } from './locale-store'
import { tIn } from '../shared/i18n'

/**
 * macOS Dock 菜单：右键/点击 Dock 上的山海图标弹出菜单，
 * 列出「打开主窗口」+ 已安装插件应用列表（点某项打开对应插件窗口）+ 退出。
 *
 * 插件安装/卸载时由 push.ts 调 refreshDockMenu 刷新（菜单项动态更新）。
 * 非 macOS（app.dock 不存在）或应用未就绪时为 no-op。
 *
 * 【i18n 期5A】本函数**每次都从模板重建整个菜单**，所以语言热更新 = 再调一次本函数
 *   （由 main/index.ts 在 onMainLocaleChange 里注册）。取词读 getMainLocale()（主进程唯一真相源）。
 * 【不翻的两类】① 插件应用名 `p.name` 来自主进程插件 manifest —— 插件生态按口径不纳入 i18n；
 *   ② console.warn 是日志，按口径①不翻。
 * 【平台限制未证实】macOS 上 `app.dock.setMenu()` 在菜单**已弹出/正在显示**时替换是否即时生效，
 *   静态无法证实，需真机验证（详见回传「原生菜单热更新的实际结论」）。
 */
export function refreshDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock || !app.isReady()) return
  try {
    const plugins = listPluginApps()
    const L = getMainLocale()
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: tIn(L, 'native.dock.openMain'), click: () => showChatWindow() },
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
    template.push({ label: tIn(L, 'native.quitApp'), click: () => app.quit() })
    app.dock.setMenu(Menu.buildFromTemplate(template))
  } catch (err) {
    console.warn('[山海] 设置 Dock 菜单失败：', err)
  }
}
