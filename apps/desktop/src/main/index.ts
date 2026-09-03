import { app, Tray, Menu, globalShortcut, nativeImage, type NativeImage } from 'electron'
import { bootHost } from '../host/index'
import { getRuntime, setRuntime } from './runtime'
import { initUiStore } from './ui-store'
import { registerPush } from './push'
import { registerIpc } from './ipc-handlers'
import { startRemoteRelay } from './remote-relay'
import { startRemoteServer } from './remote-server'
import { createWindow, loadWindowContent, showChatWindow, toggleChatWindow, ensureDesktopLayer, ICON_PATH } from './window-manager'
import { scheduleStartupUpdateCheck } from './app-updater'
import { reportDeviceStartup } from './device-report'
import { refreshDockMenu } from './dock-menu'

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

// 单例锁：同一时间只允许一个山海实例运行。
// 多实例会共用 ~/.shanhai/config.json 里的同一个 deviceId，在网关上互相顶替连接（乒乓），
// 引发「连接一直转圈」「已连接手机数虚高」等问题，因此必须禁止多开。
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  // 已有实例在运行：立即退出本实例，不创建任何窗口、不连网关。
  app.quit()
} else {
  // 有第二个实例尝试启动时：唤起并聚焦已有实例的聊天窗口，而不是再开一套。
  app.on('second-instance', () => {
    if (app.isReady()) showChatWindow()
  })

  app.whenReady().then(async () => {
    setRuntime(await bootHost())
    initUiStore(getRuntime())
    registerIpc()

    // 启动上报：匿名 POST 设备信息 + 版本到山海后台（AI 网关）。fire-and-forget，
    // 失败静默、不阻塞启动，这里不 await（否则拖慢窗口创建）。
    void reportDeviceStartup()

    // 启动时若已登录（本地凭证已恢复），自动开启远程连接（外网中继 + 局域网）。
    // 未登录则不开启，登录后由 auth:login 触发开启；退出登录由 auth:logout 自动关闭。
    if (getRuntime().loggedIn) {
      startRemoteRelay()
      startRemoteServer()
    }

    // 桌面壳窗口（全屏壁纸，忽略鼠标作为背景层；先创建，后续窗口浮在其上）
    const desktopWin = createWindow({ type: 'desktop' })
    await loadWindowContent(desktopWin)
    // Dock 窗口（底部应用图标栏，独立于桌面壳以保持可点击）
    const dockWin = createWindow({ type: 'dock' })
    await loadWindowContent(dockWin)
    // 聊天窗口（浮动在桌面之上，承载对话主界面）：默认隐藏，启动时仅显示桌面壳 + Dock + 会话管家窗口，
    // 用户通过 Dock「聊天」图标 / 托盘 / 全局快捷键打开聊天窗口
    const chatWin = createWindow({ type: 'chat', appId: 'subSession', show: false })
    await loadWindowContent(chatWin)
    // 会话管家窗口（独立常驻，右侧停靠，承载主 Agent 单会话聊天界面）
    const supervisorWin = createWindow({ type: 'supervisor', width: 500, height: 760, appId: 'mainSession' })
    await loadWindowContent(supervisorWin)
    registerPush()

    // 启动应用版本自动检查：1 秒后查一次，之后每 10 分钟查一次（发现新版本主动推送渲染层亮角标）
    scheduleStartupUpdateCheck(chatWin)

    // 恢复已安装插件（AI 自研应用跨会话/跨重启留存）：在窗口就绪 + 广播注册后执行，
    // 确保 browser 半 UI 代码能正确投递到渲染进程（否则 restore 时窗口尚未创建，投递会丢失）。
    await getRuntime().restoreInstalledPlugins()

    // Dock 图标：失败只告警，绝不因图标路径无效而中断启动（历史 bug：曾因此导致窗口创建被跳过）
    try {
      if (process.platform === 'darwin' && app.dock) app.dock.setIcon(ICON_PATH)
    } catch (err) {
      console.warn('[山海] 设置 Dock 图标失败：', err)
    }
    // Dock 菜单：列出「打开主窗口」+ 已安装插件应用列表（点某项打开对应插件窗口）。在 restore 之后调用，确保插件清单已填充
    refreshDockMenu()

    // 托盘：失败只告警，不影响主窗口使用
    try {
      createTray()
    } catch (err) {
      console.warn('[山海] 创建托盘失败：', err)
    }

    registerToggleShortcut()

    // 任意山海窗口获得焦点时纠正桌面层级：把桌面壳抬到所有非山海窗口之上、
    // 山海其它窗口保持在桌面壳之上（否则失焦再聚焦后会出现「聊天/管家窗口显示但桌面背景缺失」）
    app.on('browser-window-focus', () => ensureDesktopLayer())

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
}
