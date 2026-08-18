import { app, BrowserWindow } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHost } from '../host/index'
import { setRuntime } from './runtime'
import { registerPush } from './push'
import { registerIpc } from './ipc-handlers'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  registerPush(win)
}

app.whenReady().then(async () => {
  setRuntime(await bootHost())
  registerIpc()
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
