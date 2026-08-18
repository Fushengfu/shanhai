import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { getRuntime } from './runtime'

/**
 * 渲染进程 → 主进程 调用（IPC handler）。
 * 按业务域分组：认证 / 会话 / 审批 / 聊天 / 模型 / 用量 / 语音 / 电脑 / 目录选择。
 * 每个 handler 只做参数透传 + 调 runtime 对应能力，业务逻辑都在 @shanhai/runtime 内。
 */
export function registerIpc(): void {
  const runtime = getRuntime()

  // —— 认证 ——
  ipcMain.handle('auth:status', async () => ({ loggedIn: runtime.loggedIn, username: runtime.username }))
  ipcMain.handle('auth:login', async (_e, u: string, p: string) => runtime.login(u, p))
  ipcMain.handle('auth:logout', async () => runtime.logout())
  ipcMain.handle('auth:listModels', async () => runtime.listModels())

  // —— 会话 ——
  ipcMain.handle('session:list', async () => runtime.listSessions())
  ipcMain.handle('session:create', async (_e, title?: string, workdir?: string) => runtime.createSession(title, workdir))
  ipcMain.handle('session:switch', async (_e, id: string) => runtime.switchSession(id))
  ipcMain.handle('session:rename', async (_e, id: string, title: string) => runtime.renameSession(id, title))
  ipcMain.handle('session:delete', async (_e, id: string) => runtime.deleteSession(id))
  ipcMain.handle('session:workdir', async (_e, id?: string) => runtime.getSessionWorkdir(id))
  ipcMain.handle('session:setWorkdir', async (_e, id: string, workdir: string) => runtime.setSessionWorkdir(id, workdir))
  ipcMain.handle('session:history', async (_e, id?: string) => runtime.getSessionHistory(id))
  ipcMain.handle('session:trace', async (_e, id?: string) => runtime.getSessionTrace(id))
  ipcMain.handle('session:incomplete', async (_e, sessionId: string) => runtime.hasIncompleteTurn(sessionId))
  ipcMain.handle('file:saveUpload', async (_e, fileName: string, dataBase64: string) => runtime.saveUploadedFile(fileName, dataBase64))
  ipcMain.handle('browser:list', async (_e, sessionId?: string) => runtime.listBrowserWindows(sessionId))
  ipcMain.handle('browser:show', async (_e, appId: string) => runtime.showBrowserWindow(appId))
  ipcMain.handle('browser:close', async (_e, appId: string) => runtime.closeBrowserWindow(appId))

  // —— 审批 ——
  ipcMain.handle('approval:respond', async (_e, outcome: 'allowed-once' | 'rejected', requestId: string) =>
    runtime.respondApproval(outcome, requestId),
  )
  ipcMain.handle('approval:getPolicy', async () => runtime.getApprovalPolicy())
  ipcMain.handle('approval:setPolicy', async (_e, policy: 'ask' | 'never') => runtime.setApprovalPolicy(policy))

  // —— 聊天 ——
  ipcMain.handle('chat:run', async (_e, message: string, attachments?: Array<Record<string, unknown>>) =>
    runtime.run(message, { attachments: attachments as never }),
  )
  ipcMain.handle('chat:resend', async (_e, sessionId: string, userMessageIndex: number, newContent?: string) =>
    runtime.resend(sessionId, userMessageIndex, newContent),
  )
  ipcMain.handle('chat:resume', async (_e, sessionId: string) => runtime.resume(sessionId))
  ipcMain.handle('chat:stop', async () => runtime.stop())

  // —— 模型 ——
  ipcMain.handle('model:switch', async (_e, id: string) => runtime.switchModel(id))
  ipcMain.handle('model:current', async () => runtime.getCurrentModelId())
  ipcMain.handle('model:addCustom', async (_e, input: { name: string; baseUrl: string; apiKey: string; model: string }) =>
    runtime.addCustomModel(input),
  )
  ipcMain.handle('model:updateCustom', async (_e, id: string, input: { name: string; baseUrl: string; apiKey: string; model: string }) =>
    runtime.updateCustomModel(id, input),
  )
  ipcMain.handle('model:removeCustom', async (_e, id: string) => runtime.removeCustomModel(id))

  // —— token 用量 ——
  ipcMain.handle('token:stats', async () => runtime.getTokenStats())

  // —— 语音 ——
  ipcMain.handle('voice:speak', async (_e, text: string) => {
    await runtime.voice.synthesize(text)
  })

  // —— 系统目录选择器 ——
  ipcMain.handle('dialog:selectDirectory', async (_e, defaultPath?: string) => {
    const options: Electron.OpenDialogOptions = {
      title: '选择工作目录',
      defaultPath: defaultPath || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
    }
    const win = BrowserWindow.getAllWindows()[0]
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
