import { app, BrowserWindow, Menu, screen, type MenuItemConstructorOptions } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPluginApp, resolvePluginEntryHtml } from './plugin-apps'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 应用图标路径（dist/main → ../../assets；打包后由构建流程保证资源就位） */
export const ICON_PATH = join(__dirname, '../../assets/icon-256.png')

/** 是否为 Windows 平台（Windows 下 roundedCorners 选项无效，frameless 窗口是直角，需透明窗口 + CSS 圆角弥补） */
const isWin = process.platform === 'win32'

/**
 * 窗口类型（山海多窗口桌面系统的三类窗口）：
 * - desktop：桌面壳窗口（全屏壁纸 + 应用图标 Dock，作为「桌面」背景层）
 * - chat：聊天窗口（浮动在桌面之上，承载对话主界面）
 * - app：应用窗口（终端/轨迹/记忆/设置/模型管理等独立插件应用，按 appId 区分，可多开）
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
/** 外部窗口（浏览器窗口等由其它模块自建的窗口）：纳入桌面层级纠正，但不进主窗口注册表 */
const externalWindows = new Set<BrowserWindow>()
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
  /** app 类型窗口的应用 id（terminal/trace/memory/settings/models 等），用于多开区分 */
  appId?: string
  width?: number
  height?: number
  fullscreen?: boolean
  show?: boolean
  /** 是否插件应用窗口（true 时挂插件专用 preload，只暴露 window.shanhaiPlugin 白名单桥；内置 app 保持全量 window.shanhai） */
  isPlugin?: boolean
}

/**
 * 统一创建窗口：注入窗口类型参数（preload 据此暴露 windowType），维护注册表与关闭行为。
 * 关闭语义按类型区分：chat/desktop 点关闭只隐藏（常驻，托盘/快捷键恢复）；app 直接销毁（用完即关）。
 */
export function createWindow(opts: CreateWindowOptions): BrowserWindow {
  const { type, appId, isPlugin } = opts
  // 桌面壳窗口：无边框 + 覆盖屏幕工作区（workArea = 屏幕减去系统菜单栏与 Dock，保留系统 UI 可见；
  // 非原生 fullscreen space，避免聊天窗口被切到别的 Space）
  // Dock 窗口：无边框、底部居中的 Dock 栏（应用图标，独立于桌面壳以便可点击）
  const display = screen.getPrimaryDisplay()
  let shellBounds: Electron.Rectangle | undefined
  let supervisorBounds: Electron.Rectangle | undefined
  let appBounds: Electron.Rectangle | undefined
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
  } else if (type === 'app') {
    // 应用/插件弹窗：贴 Dock 上方弹出（不顶到屏幕最顶部），水平居中。
    // 取 Dock 窗口实际 bounds 对齐（Dock 尺寸随内容自适应），Dock 不可见时回退到工作区底部默认值。
    const aw = opts.width ?? 980
    const ah = opts.height ?? 720
    const dockWin = findWindow('dock')
    let dockTop: number
    if (dockWin && !dockWin.win.isDestroyed() && dockWin.win.isVisible()) {
      dockTop = dockWin.win.getBounds().y
    } else {
      // 回退：Dock 初始高 96，位于工作区底部上方 24px
      dockTop = display.workArea.y + display.workArea.height - 96 - 24
    }
    const gap = 12
    appBounds = {
      x: display.workArea.x + Math.floor((display.workArea.width - aw) / 2),
      y: Math.max(display.workArea.y, dockTop - gap - ah),
      width: aw,
      height: ah,
    }
  }

  const win = new BrowserWindow({
    ...(shellBounds ?? supervisorBounds ?? appBounds ?? { width: opts.width ?? 1080, height: opts.height ?? 760 }),
    // 所有窗口统一 frameless（frame:false），彻底去掉 macOS 系统红绿灯，标题栏/关闭由渲染层自定义组件承担。
    // desktop/dock 额外 focusable:false（不接受键盘焦点，点击不抢焦点，但仍可接收鼠标事件）。
    // supervisor 保持可聚焦（它是可交互的聊天窗口）。
    ...(shellBounds ? { frame: false, focusable: false } : { frame: false }),
    ...(type === 'dock' || type === 'supervisor-bubble' || (isWin && (type === 'chat' || type === 'supervisor' || type === 'app' || type === 'desktop'))
      ? { transparent: true, backgroundColor: '#00000000', hasShadow: false }
      : {}),
    ...(type === 'supervisor-bubble' ? { alwaysOnTop: true, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true } : {}),
    // 会话管家窗口：永远置顶，始终浮在所有山海其它窗口之上（不被 chat/desktop/app 盖住），便于长期可见。
    // alwaysOnTop 不影响最小化/关闭/拖动；悬浮图标(supervisor-bubble)已置顶，此处对齐管家主窗口。
    ...(type === 'supervisor' ? { alwaysOnTop: true } : {}),
    ...(type === 'app' ? { alwaysOnTop: true } : {}),
    fullscreen: shellBounds ? false : (opts.fullscreen ?? false),
    show: opts.show ?? true,
    icon: ICON_PATH,
    webPreferences: {
      // 插件应用窗口挂专用 preload（只暴露 window.shanhaiPlugin 白名单桥），内置 app 窗口保持全量 window.shanhai
      preload: join(__dirname, isPlugin ? '../preload/plugin.cjs' : '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 管家窗口禁用 Chromium 后台节流：管家常驻但经常非焦点，Electron 默认 backgroundThrottling=true 会暂停其
      // rAF / 定时器，导致流式输出、子会话回传通知(✅完成)、输入反馈等渲染被推迟到回前台才一次性 flush，
      // 表现为「迟迟不显示、突然蹦出来」。禁用后这些 UI 刷新即时生效，与其它窗口保持一致的跟手体验。
      ...(type === 'supervisor' ? { backgroundThrottling: false } : {}),
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
  attachSnapToWindow(win, type)
  return win
}

/** 根据 BrowserWindow 实例反查其窗口类型（用于主进程按窗口类型过滤广播，避免把重快照发给不消费共享状态的窗口） */
export function getWindowType(win: BrowserWindow): WindowType | undefined {
  for (const meta of windows.values()) {
    if (meta.win === win) return meta.type
  }
  return undefined
}

/** 根据 BrowserWindow 实例反查其 appId（plugin:invoke 校验发起插件窗口身份用；无则 undefined） */
export function getWindowAppId(win: BrowserWindow): string | undefined {
  for (const meta of windows.values()) {
    if (meta.win === win) return meta.appId
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
  // 任意窗口 show 后，macOS 可能把全屏桌面壳 raise 到最前并盖住其它窗口，立即把桌面压回背景层。
  // 同时把桌面壳抬到所有非山海窗口之上（见 ensureDesktopLayer），避免「聊天/管家窗口显示但桌面背景缺失」。
  ensureDesktopLayer()
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
 * 把桌面壳窗口压回最底：将所有可见的「非桌面」窗口 moveTop()（提升 z-order），但不抢焦点。
 * macOS 上任意窗口 show()/focus() 都可能把全屏桌面壳 raise 到最前并盖住其它窗口，
 * 因此在所有「窗口出现」路径（showWindow）统一调用，确保桌面壳始终待在背景层。
 */
export function keepDesktopAtBottom(): void {
  for (const meta of windows.values()) {
    if (meta.type === 'desktop') continue
    if (meta.win.isDestroyed() || !meta.win.isVisible()) continue
    meta.win.moveTop()
  }
  // 外部窗口（浏览器窗口等）：同样抬回桌面壳之上，避免点标签显示后又被全屏桌面壳盖住
  for (const win of externalWindows) {
    if (win.isDestroyed() || !win.isVisible()) continue
    win.moveTop()
  }
}

/** 注册外部窗口（如浏览器窗口），使其参与桌面层级纠正（被桌面壳盖住时能被抬回） */
export function registerExternalWindow(win: BrowserWindow): void {
  externalWindows.add(win)
}

/** 注销外部窗口（窗口销毁时调用） */
export function unregisterExternalWindow(win: BrowserWindow): void {
  externalWindows.delete(win)
}

/**
 * 桌面层级纠正：把桌面壳抬到所有非山海进程窗口之上，再让山海其它窗口保持在桌面壳之上。
 * 这是跨应用层级的唯一纠正点——keepDesktopAtBottom 只处理山海内部（非桌面窗口在桌面壳之上），
 * 无法把桌面壳从 Chrome/Finder 等外部窗口下方抬回来。山海应用失焦时外部窗口会盖住桌面壳，
 * 重新聚焦山海窗口后必须显式 moveTop 桌面壳，否则会出现「聊天/管家窗口浮在外部窗口之上，但桌面背景缺失」。
 */
export function ensureDesktopLayer(): void {
  const desktop = findWindow('desktop')
  if (desktop && !desktop.win.isDestroyed()) {
    if (!desktop.win.isVisible()) desktop.win.show()
    desktop.win.moveTop() // 桌面壳抬到前台，排在所有非山海窗口之上
  }
  // 桌面壳恢复时同步恢复 Dock：「退出到桌面」会隐藏全部窗口，恢复时必须把 Dock 一并带回，否则只剩聊天窗口没有桌面背景和图标栏
  const dock = findWindow('dock')
  if (dock && !dock.win.isDestroyed() && !dock.win.isVisible()) {
    dock.win.show()
  }
  keepDesktopAtBottom() // 再把山海其它可见窗口抬回桌面壳之上
}

/**
 * 退出到桌面：隐藏所有山海窗口（桌面壳 / Dock / 聊天 / 管家 / 悬浮图标 / 应用窗口），回到系统原始界面。
 * 应用不退出（托盘常驻），通过托盘「显示主窗口」或全局快捷键恢复；恢复时 ensureDesktopLayer 会把桌面壳 + Dock 一并带回。
 */
export function hideToSystemDesktop(): void {
  for (const meta of windows.values()) {
    if (!meta.win.isDestroyed() && meta.win.isVisible()) {
      meta.win.hide()
    }
  }
}

/**
 * 把桌面壳窗口压回最底（点击壁纸 / Dock 空隙 / 关闭 app 后兜底恢复）。
 * macOS 点击任何窗口都会把它提升到最前（z-order），focusable:false 也拦不住；桌面是全屏窗口，
 * 一旦被点击就会盖住其它窗口。这里把所有「非桌面」可见窗口 moveTop() 移回桌面之上，
 * 但不抢焦点、也不强制唤起聊天窗口（聊天窗口是否显示由用户通过 Dock 入口 / 快捷键决定）。
 */
export function restoreAboveDesktop(): void {
  ensureDesktopLayer()
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

/** 获取 Dock 窗口顶部距桌面壳底部（= 屏幕 workArea 底部）的距离（像素），供应用菜单面板定位在 Dock 上方弹出 */
export function getDockTopOffset(): number {
  const display = screen.getPrimaryDisplay()
  const dock = findWindow('dock')
  if (dock && !dock.win.isDestroyed() && dock.win.isVisible()) {
    const b = dock.win.getBounds()
    return display.workArea.y + display.workArea.height - b.y
  }
  // 回退：Dock 初始高 96，位于工作区底部上方 24px
  return 96 + 24
}

/** 最小化窗口（自定义标题栏按钮用，按发起窗口定位）。聊天窗口的最小化 = 隐藏（与关闭一致，常驻窗口不缩到系统 Dock），app 类窗口走系统最小化。 */
export function minimizeWindow(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return
  if (getWindowType(win) === 'chat') {
    win.hide()
    return
  }
  win.minimize()
}

/** Windows 透明窗口最大化前 bounds 快照（key 为 BrowserWindow.id），用于 toggleMaximizeWindow 还原 */
const preMaximizeBounds = new Map<number, Electron.Rectangle>()

/** 切换窗口最大化/还原（自定义标题栏按钮用，按发起窗口定位），返回操作后的最大化状态 */
export function toggleMaximizeWindow(win: BrowserWindow | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false
  // Windows 透明窗口（chat/supervisor/app）无法用原生 maximize()（DWM 限制），改用手动 setBounds 到 workArea 模拟。
  // 记录最大化前 bounds 用于还原；窗口一旦被拖动/缩放（非本函数），保存的 bounds 可能过期，属模拟方案的已知边界。
  const wtype = getWindowType(win)
  if (isWin && (wtype === 'chat' || wtype === 'supervisor' || wtype === 'app')) {
    const saved = preMaximizeBounds.get(win.id)
    if (saved) {
      preMaximizeBounds.delete(win.id)
      win.setBounds(saved)
      return false
    }
    preMaximizeBounds.set(win.id, win.getBounds())
    const wa = screen.getPrimaryDisplay().workArea
    win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height })
    return true
  }
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
  // 聊天窗口是常驻主窗口（非 app 类型），Dock 图标点击转发到聊天窗口
  if (appId === 'chat') {
    showChatWindow()
    return true
  }
  const existing = findWindow('app', appId)
  if (existing) {
    showWindow(existing.win)
    return true
  }
  const win = createWindow({ type: 'app', appId, width: 980, height: 720, isPlugin: isPluginApp(appId) })
  // 插件窗口：加载编译产物 dist/client.html（独立渲染入口，支持完整 React + JSX + 依赖 + 复杂 UI）。
  // 内置 app 窗口（terminal/trace/memory/models 等）保持统一 renderer 不变。
  const pluginEntry = isPluginApp(appId) ? resolvePluginEntryHtml(appId) : undefined
  if (pluginEntry) {
    await win.loadFile(pluginEntry)
  } else {
    await loadWindowContent(win)
  }
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

// ==================== 窗口磁吸 + 联动移动（snap & dock）====================

/** 参与磁吸联动的窗口类型：管家窗口（supervisor）↔ 子会话窗口（chat） */
const SNAP_TYPES: ReadonlySet<WindowType> = new Set<WindowType>(['chat', 'supervisor'])

/** 磁吸阈值（px）：窗口边距小于此值触发吸附对齐 */
const SNAP_THRESHOLD = 16
/** 解绑阈值（px）：已绑定窗口边距超过此值进入解绑缓冲（不再单帧立即解绑，避免跟随滞后误断开） */
const DETACH_THRESHOLD = 48
/** move 事件节流间隔（ms，约 60fps） */
const SNAP_THROTTLE_MS = 16
/** 程序性移动目标兜底清除延迟（ms）：setPosition 到相同位置不触发 move 时的标记清理 */
const PROGRAMMATIC_GRACE_MS = 120
/** 解绑缓冲：连续 N 次「边距超阈值」才真正解绑（单帧抖动不误断开，快速甩开仍能解绑） */
const DETACH_STREAK_MAX = 3

/** 程序性移动目标：windowId -> 目标坐标。move 事件里仅当「当前 bounds 命中目标」才判定为程序性移动跳过。 */
const programmaticMove = new Map<number, { x: number; y: number }>()

/** 绑定关系：windowId -> { partnerId, dx, dy }，dx/dy 为 partner 相对自身的偏移 */
interface SnapBinding { partnerId: number; dx: number; dy: number }
const snapBindings = new Map<number, SnapBinding>()

/** move 事件节流时间戳（key = BrowserWindow.id） */
const lastSnapMoveTs = new Map<number, number>()

/** 解绑缓冲计数（key = BrowserWindow.id）：连续超阈值次数 */
const detachStreak = new Map<number, number>()

/**
 * 程序性移动：移动前记录目标坐标，setPosition 触发的自身 move 事件经「坐标命中」判定后跳过（防递归）。
 * 相比布尔集合 + 短 setTimeout 兜底，坐标匹配不会因 move 事件派发延迟而把后续手拖误判为程序移动，
 * 从根上消除联动时的抖动；setTimeout 兜底仅用于「setPosition 到相同位置不触发 move」时的标记清理。
 */
function moveProgrammatic(win: BrowserWindow, x: number, y: number): void {
  const id = win.id
  const nx = Math.round(x)
  const ny = Math.round(y)
  programmaticMove.set(id, { x: nx, y: ny })
  try {
    win.setPosition(nx, ny)
  } finally {
    setTimeout(() => {
      const t = programmaticMove.get(id)
      if (t && t.x === nx && t.y === ny) programmaticMove.delete(id)
    }, PROGRAMMATIC_GRACE_MS)
  }
}

/** 找到与 win 配对的另一个磁吸窗口（chat ↔ supervisor） */
function findSnapPartner(win: BrowserWindow, type: WindowType): BrowserWindow | undefined {
  const targetType: WindowType = type === 'supervisor' ? 'chat' : 'supervisor'
  const found = findWindow(targetType)
  if (!found || found.win.id === win.id || found.win.isDestroyed() || !found.win.isVisible()) return undefined
  return found.win
}

/** 两个矩形是否落在同一显示器（跨屏不参与磁吸联动，避免乱吸） */
function sameDisplay(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  try {
    return screen.getDisplayMatching(a).id === screen.getDisplayMatching(b).id
  } catch {
    return false
  }
}

/** 两窗口最近边距（水平/垂直方向各取最小 gap，再取全局最小） */
function minEdgeGap(a: Electron.Rectangle, b: Electron.Rectangle): number {
  const hGap = Math.min(Math.abs(b.x - (a.x + a.width)), Math.abs(a.x - (b.x + b.width)))
  const vGap = Math.min(Math.abs(b.y - (a.y + a.height)), Math.abs(a.y - (b.y + b.height)))
  return Math.min(hGap, vGap)
}

/** 计算吸附目标位置（win 贴到 partner 最近的一条边，另一维度保持不动） */
function computeSnap(a: Electron.Rectangle, b: Electron.Rectangle): { x: number; y: number } | undefined {
  const candidates: Array<{ gap: number; x: number; y: number }> = [
    { gap: Math.abs(b.x - (a.x + a.width)), x: b.x - a.width, y: a.y }, // A 右贴 B 左
    { gap: Math.abs(a.x - (b.x + b.width)), x: b.x + b.width, y: a.y }, // A 左贴 B 右
    { gap: Math.abs(b.y - (a.y + a.height)), x: a.x, y: b.y - a.height }, // A 底贴 B 顶
    { gap: Math.abs(a.y - (b.y + b.height)), x: a.x, y: b.y + b.height }, // A 顶贴 B 底
  ]
  let best: { x: number; y: number } | undefined
  let bestGap = Infinity
  for (const c of candidates) {
    if (c.gap < SNAP_THRESHOLD && c.gap < bestGap) {
      bestGap = c.gap
      best = { x: c.x, y: c.y }
    }
  }
  return best
}

/** 解除两个窗口的绑定关系 */
function unbindSnap(a: number, b: number): void {
  snapBindings.delete(a)
  snapBindings.delete(b)
}

/** move 事件处理：节流 + 边界态过滤后，执行联动或吸附 */
function handleSnapMove(win: BrowserWindow, type: WindowType): void {
  const partner = findSnapPartner(win, type)
  if (!partner) return
  const wb = win.getBounds()
  const pb = partner.getBounds()
  if (!sameDisplay(wb, pb)) return

  const binding = snapBindings.get(win.id)
  if (binding) {
    // 已绑定：边距超过阈值 → 进入解绑缓冲（连续 N 次才真解绑），否则联动 partner 保持相对位置。
    // 缓冲可吸收「跟随滞后/单帧抖动」造成的瞬时超阈值，避免联动中误断开；快速甩开仍能解绑。
    if (minEdgeGap(wb, pb) > DETACH_THRESHOLD) {
      const streak = (detachStreak.get(win.id) ?? 0) + 1
      detachStreak.set(win.id, streak)
      if (streak >= DETACH_STREAK_MAX) {
        unbindSnap(win.id, binding.partnerId)
        detachStreak.delete(win.id)
        detachStreak.delete(binding.partnerId)
      }
      return
    }
    detachStreak.delete(win.id)
    moveProgrammatic(partner, wb.x + binding.dx, wb.y + binding.dy)
    return
  }

  // 未绑定：检测吸附，命中则吸附对齐并建立双向绑定
  const snap = computeSnap(wb, pb)
  if (!snap) return
  moveProgrammatic(win, snap.x, snap.y)
  const nwb = win.getBounds()
  const npb = partner.getBounds()
  snapBindings.set(win.id, { partnerId: partner.id, dx: npb.x - nwb.x, dy: npb.y - nwb.y })
  snapBindings.set(partner.id, { partnerId: win.id, dx: nwb.x - npb.x, dy: nwb.y - npb.y })
}

/** 给参与磁吸的窗口挂 move 监听（chat/supervisor 创建时调用，窗口重建也自动覆盖） */
function attachSnapToWindow(win: BrowserWindow, type: WindowType): void {
  if (!SNAP_TYPES.has(type)) return
  win.on('move', () => {
    // 程序性移动判定：仅当「当前 bounds 命中程序性目标坐标」才跳过（防递归）。
    // 相比布尔集合 + 短 setTimeout 兜底，坐标匹配不会因 move 事件派发延迟而把后续手拖误判为程序移动，消除抖动。
    const target = programmaticMove.get(win.id)
    if (target) {
      const b = win.getBounds()
      if (Math.abs(b.x - target.x) <= 1 && Math.abs(b.y - target.y) <= 1) {
        programmaticMove.delete(win.id)
        return
      }
    }
    if (win.isDestroyed()) return
    // 边界态：全屏/最大化/最小化不参与磁吸联动
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return
    const now = Date.now()
    const last = lastSnapMoveTs.get(win.id) ?? 0
    if (now - last < SNAP_THROTTLE_MS) return
    lastSnapMoveTs.set(win.id, now)
    handleSnapMove(win, type)
  })
  win.on('closed', () => {
    snapBindings.delete(win.id)
    programmaticMove.delete(win.id)
    lastSnapMoveTs.delete(win.id)
    detachStreak.delete(win.id)
  })
}
