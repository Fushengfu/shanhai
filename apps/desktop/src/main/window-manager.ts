import { app, BrowserWindow, Menu, screen, type MenuItemConstructorOptions } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 应用图标路径（dist/main → ../../assets；打包后由构建流程保证资源就位） */
export const ICON_PATH = join(__dirname, '../../assets/icon-256.png')

/**
 * 窗口类型（山海多窗口桌面系统的三类窗口）：
 * - desktop：桌面壳窗口（全屏壁纸 + 应用图标 Dock，作为「桌面」背景层）
 * - chat：聊天窗口（浮动在桌面之上，承载对话主界面）
 * - app：应用窗口（终端/轨迹/记忆/设置/专家/模型管理等独立插件应用，按 appId 区分，可多开）
 */
export type WindowType = 'desktop' | 'dock' | 'chat' | 'app' | 'supervisor' | 'supervisor-bubble'

/** 窗口类型通过 additionalArguments 注入渲染进程，preload 用 process.argv 读取（同步、无竞态） */
const WINDOW_TYPE_ARG = '--shanhai-window-type='
const APP_ID_ARG = '--shanhai-app-id='

/** 窗口注册表：key 为「type[:appId]:序号」，唯一标识每个窗口实例 */
export interface WindowMeta {
  type: WindowType
  appId?: string
  win: BrowserWindow
}

const windows = new Map<string, WindowMeta>()
let seq = 0

/** 应用退出标志：置 true 后放行所有窗口的 close（否则 chat/desktop 的 close 会 preventDefault 只隐藏、卡住退出） */
let isQuitting = false
app.on('before-quit', () => {
  isQuitting = true
})

/** 注册右键原生菜单（复制/粘贴/全选）：终端 xterm 自绘 selection 不走这里，由渲染进程 TerminalPanel 自理 */
function registerContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.selectionText && params.selectionText.trim().length > 0) {
      items.push({ label: '复制', role: 'copy' })
    }
    if (params.isEditable) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push({ label: '粘贴', role: 'paste' })
      items.push({ label: '全选', role: 'selectAll' })
    }
    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window: win })
  })
}

/** 加载窗口内容：dev 走 Vite dev server，prod 走打包后的 index.html */
export async function loadWindowContent(win: BrowserWindow): Promise<void> {
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

export interface CreateWindowOptions {
  type: WindowType
  /** app 类型窗口的应用 id（terminal/trace/memory/settings/experts/models 等），用于多开区分 */
  appId?: string
  width?: number
  height?: number
  fullscreen?: boolean
  show?: boolean
}

/**
 * 统一创建窗口：注入窗口类型参数（preload 据此暴露 windowType），维护注册表与关闭行为。
 * 关闭语义按类型区分：chat/desktop 点关闭只隐藏（常驻，托盘/快捷键恢复）；app 直接销毁（用完即关）。
 */
export function createWindow(opts: CreateWindowOptions): BrowserWindow {
  const { type, appId } = opts
  // 桌面壳窗口：无边框 + 覆盖屏幕工作区（workArea = 屏幕减去系统菜单栏与 Dock，保留系统 UI 可见；
  // 非原生 fullscreen space，避免聊天窗口被切到别的 Space）
  // Dock 窗口：无边框、底部居中的 Dock 栏（应用图标，独立于桌面壳以便可点击）
  const display = screen.getPrimaryDisplay()
  let shellBounds: Electron.Rectangle | undefined
  let supervisorBounds: Electron.Rectangle | undefined
  if (type === 'desktop') {
    shellBounds = { x: display.workArea.x, y: display.workArea.y, width: display.workArea.width, height: display.workArea.height }
  } else if (type === 'dock') {
    const dockWidth = 520
    const dockHeight = 96
    shellBounds = {
      x: display.workArea.x + Math.floor((display.workArea.width - dockWidth) / 2),
      y: display.workArea.y + display.workArea.height - dockHeight - 24,
      width: dockWidth,
      height: dockHeight,
    }
  } else if (type === 'supervisor') {
    // 会话管家窗口：正常尺寸（720×760），初始停靠屏幕右侧，与聊天窗口并行（保持可交互、可聚焦）
    const sw = opts.width ?? 720
    const sh = opts.height ?? 760
    supervisorBounds = {
      x: display.workArea.x + display.workArea.width - sw - 24,
      y: display.workArea.y + Math.floor((display.workArea.height - sh) / 2),
      width: sw,
      height: sh,
    }
  } else if (type === 'supervisor-bubble') {
    // 会话管家悬浮图标：小尺寸（60×60），初始停靠屏幕右侧中部，可拖动、置顶
    const bw = 60
    const bh = 60
    supervisorBounds = {
      x: display.workArea.x + display.workArea.width - bw - 24,
      y: display.workArea.y + Math.floor((display.workArea.height - bh) / 2),
      width: bw,
      height: bh,
    }
  }

  const win = new BrowserWindow({
    ...(shellBounds ?? supervisorBounds ?? { width: opts.width ?? 1080, height: opts.height ?? 760 }),
    // 所有窗口统一 frameless（frame:false），彻底去掉 macOS 系统红绿灯，标题栏/关闭由渲染层自定义组件承担。
    // desktop/dock 额外 focusable:false（不接受键盘焦点，点击不抢焦点，但仍可接收鼠标事件）。
    // supervisor 保持可聚焦（它是可交互的聊天窗口）。
    ...(shellBounds ? { frame: false, focusable: false } : { frame: false }),
    ...(type === 'dock' || type === 'supervisor-bubble' ? { transparent: true, backgroundColor: '#00000000', hasShadow: false } : {}),
    ...(type === 'supervisor-bubble' ? { alwaysOnTop: true, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true } : {}),
    fullscreen: shellBounds ? false : (opts.fullscreen ?? false),
    show: opts.show ?? true,
    icon: ICON_PATH,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `${WINDOW_TYPE_ARG}${type}`,
        ...(appId ? [`${APP_ID_ARG}${appId}`] : []),
      ],
    },
  })

  const key = `${type}${appId ? `:${appId}` : ''}:${++seq}`
  windows.set(key, { type, appId, win })

  // 桌面壳窗口：保持 focusable:false（不抢键盘焦点），但【必须接收鼠标事件】。
  // 之前用 setIgnoreMouseEvents(true) 让点击穿透，结果穿透到了 macOS 系统墙纸，触发系统「点按墙纸以显示桌面」，
  // 把所有窗口移出屏幕（表现为「整个应用隐藏」）。所以桌面必须自己接住鼠标、不穿透，
  // 点击桌面时由渲染进程 mousedown 调 restoreAboveDesktop 把聊天/应用窗口带回前面。
  // （focusable:false 仍会点击提升 z-order，但 mousedown 恢复 + 不抢焦点即可闭环，且不再触发系统级隐藏。）

  if (type === 'chat' || type === 'desktop' || type === 'dock') {
    win.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault()
        win.hide()
      }
    })
  } else if (type === 'supervisor') {
    // 管家窗口点关闭：隐藏窗口 + 显示悬浮图标（点击悬浮图标可恢复窗口）
    win.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault()
        win.hide()
        showSupervisorBubble()
      }
    })
  }

  win.on('closed', () => {
    windows.delete(key)
  })

  registerContextMenu(win)
  return win
}

/** 根据 BrowserWindow 实例反查其窗口类型（用于主进程按窗口类型过滤广播，避免把重快照发给不消费共享状态的窗口） */
export function getWindowType(win: BrowserWindow): WindowType | undefined {
  for (const meta of windows.values()) {
    if (meta.win === win) return meta.type
  }
  return undefined
}

/** 按 type 查找窗口（可选 appId）。返回第一个匹配的存活窗口，无则 undefined */
function findWindow(type: WindowType, appId?: string): { win: BrowserWindow; meta: WindowMeta } | undefined {
  for (const meta of windows.values()) {
    if (meta.type === type && meta.appId === appId && !meta.win.isDestroyed()) {
      return { win: meta.win, meta }
    }
  }
  return undefined
}

/** 显示并聚焦指定窗口（若已销毁则重建 chat 窗口） */
function showWindow(win: BrowserWindow | undefined): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 显示聊天窗口（聊天窗口是常驻主窗口，销毁则重建） */
export function showChatWindow(): void {
  const found = findWindow('chat')
  if (found) {
    showWindow(found.win)
    return
  }
  const win = createWindow({ type: 'chat' })
  void loadWindowContent(win).then(() => {
    showWindow(win)
  })
}

/** 显示会话管家窗口（常驻，销毁则重建）；显示窗口时互斥隐藏悬浮图标 */
export function showSupervisorWindow(): void {
  const bubble = findWindow('supervisor-bubble')
  if (bubble && !bubble.win.isDestroyed()) bubble.win.hide()
  const found = findWindow('supervisor')
  if (found) {
    showWindow(found.win)
    return
  }
  const win = createWindow({ type: 'supervisor' })
  void loadWindowContent(win).then(() => {
    showWindow(win)
  })
}

/** 显示会话管家悬浮图标（常驻，销毁则重建） */
function showSupervisorBubble(): void {
  const found = findWindow('supervisor-bubble')
  if (found) {
    showWindow(found.win)
    return
  }
  const win = createWindow({ type: 'supervisor-bubble' })
  void loadWindowContent(win).then(() => {
    showWindow(win)
  })
}

/** 管家窗口点关闭 → 隐藏窗口 + 显示悬浮图标 */
export function hideSupervisorToBubble(): void {
  const found = findWindow('supervisor')
  if (found && !found.win.isDestroyed()) found.win.hide()
  showSupervisorBubble()
}

/** 点击悬浮图标 → 隐藏图标 + 恢复管家窗口 */
export function showSupervisorFromBubble(): void {
  showSupervisorWindow()
}

/** 拖动悬浮图标：按位移增量移动窗口（渲染进程 mousemove 时调用） */
export function moveSupervisorBubble(dx: number, dy: number): void {
  const bubble = findWindow('supervisor-bubble')
  if (!bubble || bubble.win.isDestroyed()) return
  const b = bubble.win.getBounds()
  bubble.win.setPosition(Math.round(b.x + dx), Math.round(b.y + dy))
}

/** 隐藏聊天窗口（自定义关闭按钮用：聊天窗口常驻，点关闭只隐藏，托盘/快捷键恢复） */
export function hideChatWindow(): void {
  const found = findWindow('chat')
  if (found && !found.win.isDestroyed()) {
    found.win.hide()
  }
}

/**
 * 把聊天窗口与所有「非桌面」窗口带回桌面之上（桌面壳被点击提升 z-order 后兜底恢复）。
 * macOS 点击任何窗口都会把它提升到最前（z-order），focusable:false 也拦不住；桌面是全屏窗口，
 * 一旦被点击就会盖住聊天窗口。这里在桌面被点击（渲染进程 mousedown）时调用，把 dock/app/chat 移回桌面之上。
 * - dock / app 窗口只 moveTop()（回到桌面之上，但不抢焦点，避免打断用户）
 * - 聊天窗口 show + focus（聊天是主交互窗口，点壁纸后理应回到可输入状态）
 */
export function restoreAboveDesktop(): void {
  for (const meta of windows.values()) {
    if (meta.type === 'desktop') continue
    if (meta.win.isDestroyed() || !meta.win.isVisible()) continue
    meta.win.moveTop()
  }
  const chat = findWindow('chat')
  if (chat && !chat.win.isDestroyed()) {
    if (chat.win.isMinimized()) chat.win.restore()
    chat.win.show()
    chat.win.moveTop()
    chat.win.focus()
  }
}

/**
 * 根据内容自适应调整 Dock 窗口尺寸（渲染进程 DockApp 测量图标栏内容后回调）。
 * Dock 窗口宽高不再固定写死，随应用数量增减自动伸缩，始终底部居中。
 */
export function resizeDockWindow(width: number, height: number): void {
  const found = findWindow('dock')
  if (!found || found.win.isDestroyed()) return
  const display = screen.getPrimaryDisplay()
  const w = Math.max(300, Math.round(width))
  const h = Math.max(72, Math.round(height))
  found.win.setBounds({
    x: display.workArea.x + Math.floor((display.workArea.width - w) / 2),
    y: display.workArea.y + display.workArea.height - h - 24,
    width: w,
    height: h,
  })
}

/** 最小化窗口（自定义标题栏按钮用，按发起窗口定位） */
export function minimizeWindow(win: BrowserWindow | null | undefined): void {
  if (win && !win.isDestroyed()) win.minimize()
}

/** 切换窗口最大化/还原（自定义标题栏按钮用，按发起窗口定位），返回操作后的最大化状态 */
export function toggleMaximizeWindow(win: BrowserWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false
  if (win.isMaximized()) {
    win.unmaximize()
    return false
  }
  win.maximize()
  return true
}

/** 唤起/隐藏聊天窗口的切换（全局快捷键用） */
export function toggleChatWindow(): void {
  const found = findWindow('chat')
  if (found && found.win.isVisible() && found.win.isFocused()) {
    found.win.hide()
  } else {
    showChatWindow()
  }
}

/** 打开插件应用窗口：已有则聚焦，否则创建。app 窗口可多开（terminal 支持多个），此处按 appId 复用单实例 */
export async function openApp(appId: string): Promise<boolean> {
  // 会话管家是独立常驻窗口（非 app 类型），Dock 图标点击转发到 supervisor 窗口
  if (appId === 'supervisor') {
    showSupervisorWindow()
    return true
  }
  const existing = findWindow('app', appId)
  if (existing) {
    showWindow(existing.win)
    return true
  }
  const win = createWindow({ type: 'app', appId, width: 980, height: 720 })
  await loadWindowContent(win)
  showWindow(win)
  return true
}

/** 关闭插件应用窗口（真正销毁）；销毁后桌面可能浮上来盖住聊天窗口，故顺带把聊天窗口带回桌面之上 */
export function closeApp(appId: string): void {
  const existing = findWindow('app', appId)
  if (existing) {
    existing.win.destroy()
    restoreAboveDesktop()
  }
}

/** 列出当前所有存活窗口的元信息（供桌面壳 Dock 显示应用开/关状态，Step 3/4 使用） */
export function listWindows(): Array<{ type: WindowType; appId?: string }> {
  const out: Array<{ type: WindowType; appId?: string }> = []
  for (const meta of windows.values()) {
    if (!meta.win.isDestroyed()) out.push({ type: meta.type, appId: meta.appId })
  }
  return out
}
