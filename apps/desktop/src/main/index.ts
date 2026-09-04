import { app, Tray, Menu, globalShortcut, nativeImage, type NativeImage } from 'electron'
import { bootHost } from '../host/index'
import { getRuntime, setRuntime } from './runtime'
import { initUiStore } from './ui-store'
import { registerPush } from './push'
import { registerIpc } from './ipc-handlers'
import { startRemoteRelay, reconnectWithFreshCredential } from './remote-relay'
import { startCredentialRenewal, stopCredentialRenewal, onCredentialSnapshot } from './member-credentials'
import { startMemberChannel, reconnectMemberChannelWithFreshCredential } from './member-channel'
import { startRemoteServer } from './remote-server'
import { createWindow, loadWindowContent, showChatWindow, toggleChatWindow, ensureDesktopLayer, openApp, getOrCreateSupervisorWindow, ICON_PATH } from './window-manager'
import { subscribeMemberUnread } from './member-channel'
import { scheduleStartupUpdateCheck } from './app-updater'
import { reportDeviceStartup } from './device-report'
import { refreshDockMenu } from './dock-menu'

/** 全局唤起/隐藏主窗口的快捷键（macOS 上 CommandOrControl 即 ⌘，避开 Spotlight 的 ⌘+Space） */
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space'

// 保持引用防止 Tray 被 GC（模块级，仅创建时赋值）
let tray: Tray | null = null
/** 会员私信未读订阅的退订句柄（托盘菜单实时刷新未读项用） */
let memberUnreadOff: (() => void) | null = null
/** 凭证状态订阅的退订句柄（续签成功后驱动两条连接重连） */
let credentialSnapshotOff: (() => void) | null = null
let isQuitting = false

function createTrayIcon(): NativeImage {
  // 托盘图标与应用图标统一：直接用主图标缩小到菜单栏尺寸（彩色，不设模板）
  const image = nativeImage.createFromPath(ICON_PATH)
  const scaled = image.resize({ width: 18, height: 18 })
  return scaled
}

/** 托盘菜单：按当前私信未读数重建（未登录/无未读时不显示该项，保持菜单干净） */
function refreshTrayMenu(unreadTotal: number): void {
  if (!tray || tray.isDestroyed()) return
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: '显示主窗口', click: () => showChatWindow() },
  ]
  if (unreadTotal > 0) {
    template.push({ label: `打开私信（${unreadTotal > 99 ? '99+' : unreadTotal} 条未读）`, click: () => void openApp('messages') })
  }
  template.push({ type: 'separator' })
  template.push({
    label: '退出山海',
    click: () => {
      isQuitting = true
      app.quit()
    },
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('山海 AI 助手')
  refreshTrayMenu(0)
  // 订阅会员私信未读变化（主进程内回调，不经渲染层），实时刷新托盘未读项
  memberUnreadOff = subscribeMemberUnread((u) => refreshTrayMenu(u?.total ?? 0))
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

    // 启动时若已登录（本地凭证已恢复），自动开启远程连接（外网中继 + 局域网）与会员通道（私信/好友）。
    // 未登录则不开启，登录后由 auth:login 触发开启；退出登录由 auth:logout 自动关闭。
    // 会员通道必须是第二条独立连接（role=member），与上面的 host 远程控制连接互不复用。
    if (getRuntime().loggedIn) {
      startRemoteRelay()
      startRemoteServer()
      startMemberChannel()
    }
    // 凭证续签（会员 JWT 到期前自动续签 + 401 时先续签再重连）：
    // 必须在两条连接之后拉起，让「启动即已过期」的立即检查能顺带把两条连接带新 token 重连。
    startCredentialRenewal()
    // 续签成功 → 通知远程控制与私信两条连接立即用新 token 重连（不等下一次退避）
    let lastRotated: number | null = null
    credentialSnapshotOff = onCredentialSnapshot((snap) => {
      if (!snap.lastRotatedAt || snap.lastRotatedAt === lastRotated) return
      lastRotated = snap.lastRotatedAt
      reconnectWithFreshCredential()
      reconnectMemberChannelWithFreshCredential()
    })

    // 桌面壳窗口（全屏壁纸，忽略鼠标作为背景层；先创建，后续窗口浮在其上）
    const desktopWin = createWindow({ type: 'desktop' })
    await loadWindowContent(desktopWin)
    // Dock 窗口（底部应用图标栏，独立于桌面壳以保持可点击）
    const dockWin = createWindow({ type: 'dock' })
    await loadWindowContent(dockWin)
    // 聊天窗口（浮动在桌面之上，承载对话主界面）：默认隐藏，启动时仅显示桌面壳 + Dock + 会话管家窗口，
    // 用户通过 Dock「聊天」图标 / 托盘 / 全局快捷键打开聊天窗口
    const chatWin = createWindow({ type: 'chat', appId: 'subSession', show: true })
    await loadWindowContent(chatWin)
    // 会话管家窗口（独立常驻，右侧停靠，承载主 Agent 单会话聊天界面）
    // ⚠️ 必须走 getOrCreateSupervisorWindow（全进程【唯一】创建入口）：旧写法在这里直接 createWindow，
    // 与 showSupervisorWindow 形成两个入口，且打的 appId 'mainSession' 让按类型查找恒失配 →
    // 点关闭关不掉（还无条件弹悬浮图标）、点悬浮图标又新建一个 → 「悬浮按钮与窗口共存 + 两个管家窗口」。
    const { win: supervisorWin, created: supervisorCreated } = getOrCreateSupervisorWindow({ width: 500, height: 760 })
    if (supervisorCreated) await loadWindowContent(supervisorWin)
    registerPush()

    // 启动应用版本自动检查：1 秒后查一次，之后每 10 分钟查一次。
    // 发现新版本由主进程弹原生对话框提醒（同一版本号只自动弹一次，跨重启持久化）；
    // 检查结果同时广播到所有窗口，下载过程在渲染层显示进度浮层。
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
    // 退订会员未读监听（托盘菜单 / Dock 角标），避免退出流程里回调打到已销毁的 Tray
    memberUnreadOff?.()
    memberUnreadOff = null
    credentialSnapshotOff?.()
    credentialSnapshotOff = null
    stopCredentialRenewal()
    globalShortcut.unregisterAll()
  })

  app.on('window-all-closed', () => {
    // macOS 常驻托盘，关窗不退出；其他平台仍按默认退出
    if (process.platform !== 'darwin') app.quit()
  })
}
