import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHost } from '../host/index'
import type { Runtime } from '@shanhai/runtime'

const __dirname = dirname(fileURLToPath(import.meta.url))

let runtime: Runtime | null = null

/** 主进程 → 渲染进程 事件推送（流式增量 / 工具过程 / 审批请求） */
function registerPush(win: BrowserWindow): void {
  if (!runtime) return
  runtime.onDelta((text) => {
    if (!win.isDestroyed()) win.webContents.send('chat:delta', text)
  })
  runtime.onToolTrace((trace) => {
    if (!win.isDestroyed()) win.webContents.send('tool:trace', trace)
  })
  runtime.onApprovalRequest((req) => {
    if (!win.isDestroyed()) win.webContents.send('approval:request', req)
  })
}

/** 渲染进程 → 主进程 调用（登录 / 会话 / 模型 / 审批 / 跑任务） */
function registerIpc(): void {
  ipcMain.handle('auth:status', async () => ({ loggedIn: runtime!.loggedIn, username: runtime!.username }))
  ipcMain.handle('auth:login', async (_e, u: string, p: string) => runtime!.login(u, p))
  ipcMain.handle('auth:logout', async () => runtime!.logout())
  ipcMain.handle('auth:listModels', async () => runtime!.listModels())
  ipcMain.handle('session:list', async () => runtime!.listSessions())
  ipcMain.handle('session:switch', async (_e, id: string) => runtime!.switchSession(id))
  ipcMain.handle('approval:respond', async (_e, outcome: 'allowed-once' | 'rejected') => runtime!.respondApproval(outcome))
  ipcMain.handle('chat:run', async (_e, message: string, attachments?: Array<Record<string, unknown>>) =>
    runtime!.run(message, { attachments: attachments as never }),
  )
  ipcMain.handle('model:switch', async (_e, id: string) => runtime!.switchModel(id))
  ipcMain.handle('model:current', async () => runtime!.getCurrentModelId())
  ipcMain.handle('chat:stop', async () => runtime!.stop())
  ipcMain.handle('voice:speak', async (_e, text: string) => {
    await runtime!.voice.synthesize(text)
  })
  ipcMain.handle('computer:shot', async () => {
    const buf = await runtime!.computerUse.screenshot()
    return Buffer.from(buf).toString('base64')
  })
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

  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  registerPush(win)
}

app.whenReady().then(async () => {
  runtime = await bootHost()
  registerIpc()
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
