import { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, type NativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHost } from '../host/index'
import { setRuntime } from './runtime'
import { registerPush } from './push'
import { registerIpc } from './ipc-handlers'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 全局唤起/隐藏主窗口的快捷键（macOS 上 CommandOrControl 即 ⌘，避开 Spotlight 的 ⌘+Space） */
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space'

/** 菜单栏模板图标（单色「山」形 18×18，setTemplateImage 自动适配深浅色菜单栏） */
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAANElEQVR4nGNgGDHgPxmYKoZRxWVU8yLRgCqGUNUgXIaRBahmELphFAGqGcRALUOoatAQBAAgtUm3eMXTrAAAAABJRU5ErkJggg=='

let mainWindow: BrowserWindow | null = null
// 保持引用防止 Tray 被 GC（模块级，仅创建时赋值）
let tray: Tray | null = null
let isQuitting = false

function createTrayIcon(): NativeImage {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`)
  image.setTemplateImage(true)
  return image
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleMainWindow(): void {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
  } else {
    showMainWindow()
  }
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win

  // 点红色关闭按钮 → 最小化到托盘常驻（真正退出走托盘菜单「退出」/ ⌘Q，先置 isQuitting）
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  registerPush(win)
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('山海 AI 助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
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
  tray.on('click', () => showMainWindow())
}

function registerToggleShortcut(): void {
  const ok = globalShortcut.register(TOGGLE_SHORTCUT, () => toggleMainWindow())
  if (!ok) {
    console.warn(`[山海] 全局快捷键 ${TOGGLE_SHORTCUT} 注册失败（可能被其他应用占用）`)
  }
}

app.whenReady().then(async () => {
  setRuntime(await bootHost())
  registerIpc()
  await createWindow()
  createTray()
  registerToggleShortcut()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    else showMainWindow()
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
