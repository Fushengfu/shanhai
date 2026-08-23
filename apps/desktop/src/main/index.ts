import { app, Tray, Menu, globalShortcut, nativeImage, type NativeImage } from 'electron'
import { bootHost } from '../host/index'
import { getRuntime, setRuntime } from './runtime'
import { initUiStore } from './ui-store'
import { registerPush } from './push'
import { registerIpc } from './ipc-handlers'
import { createWindow, loadWindowContent, showChatWindow, toggleChatWindow, ICON_PATH } from './window-manager'

/** 全局唤起/隐藏主窗口的快捷键（macOS 上 CommandOrControl 即 ⌘，避开 Spotlight 的 ⌘+Space） */
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space'

// 保持引用防止 Tray 被 GC（模块级，仅创建时赋值）
let tray: Tray | null = null
let isQuitting = false

function createTrayIcon(): NativeImage {
  // 托盘图标与应用图标统一：直接用主图标缩小到菜单栏尺寸（彩色，不设模板）
  const image = nativeImage.createFromPath(ICON_PATH)
  const scaled = image.resize({ width: 18, height: 18 })
  return scaled
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('山海 AI 助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showChatWindow() },
      { type: 'separator' },
      {
        label: '退出山海',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  // macOS 左键单击托盘图标唤出窗口（右键仍走 contextMenu）
  tray.on('click', () => showChatWindow())
}

function registerToggleShortcut(): void {
  const ok = globalShortcut.register(TOGGLE_SHORTCUT, () => toggleChatWindow())
  if (!ok) {
    console.warn(`[山海] 全局快捷键 ${TOGGLE_SHORTCUT} 注册失败（可能被其他应用占用）`)
  }
}

app.whenReady().then(async () => {
  setRuntime(await bootHost())
  initUiStore(getRuntime())
  registerIpc()

  // 桌面壳窗口（全屏壁纸，忽略鼠标作为背景层；先创建，后续窗口浮在其上）
  const desktopWin = createWindow({ type: 'desktop' })
  await loadWindowContent(desktopWin)
  // Dock 窗口（底部应用图标栏，独立于桌面壳以保持可点击）
  const dockWin = createWindow({ type: 'dock' })
  await loadWindowContent(dockWin)
  // 聊天窗口（浮动在桌面之上，承载对话主界面）
  const chatWin = createWindow({ type: 'chat' })
  await loadWindowContent(chatWin)
  // 会话管家窗口（独立常驻，右侧停靠，承载主 Agent 单会话聊天界面）
  const supervisorWin = createWindow({ type: 'supervisor' })
  await loadWindowContent(supervisorWin)
  registerPush()

  // 恢复已安装插件（AI 自研应用跨会话/跨重启留存）：在窗口就绪 + 广播注册后执行，
  // 确保 browser 半 UI 代码能正确投递到渲染进程（否则 restore 时窗口尚未创建，投递会丢失）。
  await getRuntime().restoreInstalledPlugins()

  // Dock 图标：失败只告警，绝不因图标路径无效而中断启动（历史 bug：曾因此导致窗口创建被跳过）
  try {
    if (process.platform === 'darwin' && app.dock) app.dock.setIcon(ICON_PATH)
  } catch (err) {
    console.warn('[山海] 设置 Dock 图标失败：', err)
  }

  // 托盘：失败只告警，不影响主窗口使用
  try {
    createTray()
  } catch (err) {
    console.warn('[山海] 创建托盘失败：', err)
  }

  registerToggleShortcut()

  app.on('activate', () => {
    if (app.isReady()) showChatWindow()
  })
})

// ⌘Q / Dock 右键退出：先置 isQuitting，让 close 事件放行（否则窗口只会 hide 不会退出）
app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // macOS 常驻托盘，关窗不退出；其他平台仍按默认退出
  if (process.platform !== 'darwin') app.quit()
})
