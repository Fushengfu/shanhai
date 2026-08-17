import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHost } from '../host/index'
import type { Runtime } from '@shanhai/runtime'

const __dirname = dirname(fileURLToPath(import.meta.url))

let runtime: Runtime | null = null

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 调试监听（renderer 加载/报错）
  win.webContents.on('did-finish-load', () => {
    console.log('[renderer] did-finish-load')
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer] did-fail-load', code, desc, url)
  })
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer:console]', message)
  })

  // 跑任务：流式把 assistant/delta 推给 renderer（UI 实时逐字渲染）
  ipcMain.handle('chat:run', async (_event, message: string) => {
    if (!runtime) throw new Error('runtime not ready')
    return runtime.agent.run(message, {
      onDelta: (text) => {
        if (!win.isDestroyed()) win.webContents.send('chat:delta', text)
      },
    })
  })
}

app.whenReady().then(async () => {
  runtime = await bootHost()
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
