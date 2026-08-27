import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { SUPERVISOR_ID } from '@shanhai/runtime'
import { getRuntime } from './runtime'
import { openApp, closeApp, restoreAboveDesktop, hideChatWindow, minimizeWindow, toggleMaximizeWindow, resizeDockWindow, hideSupervisorToBubble, showSupervisorFromBubble, moveSupervisorBubble, hideToSystemDesktop, getWindowType } from './window-manager'
import { getUiState, patchUiState, getWallpaper, setWallpaper, filterUiStateForWindow, type UiStoreState } from './ui-store'
import { listSystemWallpapers, applySystemWallpaper } from './system-wallpaper'
import { startRemoteServer, stopRemoteServer, getRemoteStatus } from './remote-server'
import { startRemoteRelay, stopRemoteRelay, getRelayStatus, getRelayPreference } from './remote-relay'
import { checkAndPromptForUpdate, getLastUpdateCheckResult, fetchMobileApkInfo } from './app-updater'

/**
 * 渲染进程 → 主进程 调用（IPC handler）。
 * 按业务域分组：认证 / 会话 / 审批 / 聊天 / 模型 / 用量 / 语音 / 电脑 / 目录选择。
 * 每个 handler 只做参数透传 + 调 runtime 对应能力，业务逻辑都在 @shanhai/runtime 内。
 */
export function registerIpc(): void {
  const runtime = getRuntime()

  // —— 认证 ——
  ipcMain.handle('auth:status', async () => ({ loggedIn: runtime.loggedIn, username: runtime.username }))
  ipcMain.handle('auth:login', async (_e, u: string, p: string) => {
    const result = await runtime.login(u, p)
    // 登录成功后，若用户之前开启过中继，自动恢复连接（覆盖「启动时未登录、登录后补连」的场景）
    if (getRelayPreference()) startRemoteRelay()
    return result
  })
  ipcMain.handle('auth:logout', async () => runtime.logout())
  ipcMain.handle('auth:listModels', async () => runtime.listModels())
  ipcMain.handle('auth:refreshModels', async () => runtime.refreshModels())

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
  ipcMain.handle('session:retry-snapshot', async (_e, sessionId: string) => runtime.hasRetrySnapshot(sessionId))
  ipcMain.handle('file:saveUpload', async (_e, fileName: string, dataBase64: string) => runtime.saveUploadedFile(fileName, dataBase64))
  ipcMain.handle('image:upload', async (_e, imageBase64: string, mimeType?: string) => runtime.uploadImage(imageBase64, mimeType))
  ipcMain.handle('browser:list', async (_e, sessionId?: string) => runtime.listBrowserWindows(sessionId))
  ipcMain.handle('browser:show', async (_e, appId: string) => runtime.showBrowserWindow(appId))
  ipcMain.handle('browser:close', async (_e, appId: string) => runtime.closeBrowserWindow(appId))
  ipcMain.handle('deepseek-bridge:status', async () => runtime.getDeepSeekBridgeStatus())
  ipcMain.handle('deepseek-bridge:open', async () => runtime.openDeepSeekBridge())
  ipcMain.handle('deepseek-bridge:inject', async () => runtime.injectDeepSeekBridge())

  // —— 用户手动终端（会话级隔离，多开多个）——
  ipcMain.handle('userTerminal:create', async (_e, sessionId: string, name?: string) => runtime.userTerminalCreate(sessionId, name))
  ipcMain.handle('userTerminal:list', async (_e, sessionId: string) => runtime.userTerminalList(sessionId))
  ipcMain.handle('userTerminal:close', async (_e, sessionId: string, terminalId: string) => runtime.userTerminalClose(sessionId, terminalId))
  // 写入/调尺寸为高频 fire-and-forget（每个按键一次），用 on 而非 handle，避免每次 round-trip 返回
  ipcMain.on('userTerminal:write', (_e, sessionId: string, terminalId: string, data: string) => runtime.userTerminalWrite(sessionId, terminalId, data))
  ipcMain.on('userTerminal:resize', (_e, sessionId: string, terminalId: string, cols: number, rows: number) => runtime.userTerminalResize(sessionId, terminalId, cols, rows))

  // —— 审批 ——
  ipcMain.handle('approval:respond', async (_e, outcome: 'allowed-once' | 'rejected', requestId: string) =>
    runtime.respondApproval(outcome, requestId),
  )
  ipcMain.handle('approval:getPolicy', async () => runtime.getApprovalPolicy())
  ipcMain.handle('approval:setPolicy', async (_e, policy: 'ask' | 'workdir' | 'never') => runtime.setApprovalPolicy(policy))

  // —— AI 向用户提问（单选/多选/填空/选择器）——
  ipcMain.handle('ask:respond', async (_e, requestId: string, answer: string) => runtime.respondAsk(requestId, answer))
  ipcMain.handle('ask:cancel', async (_e, requestId: string) => runtime.cancelAsk(requestId))

  // —— 自修改（K5）——
  ipcMain.handle('selfmod:inspect', async (_e, sessionId?: string) => runtime.selfmodInspect(sessionId))
  ipcMain.handle('selfmod:respond', async (_e, requestId: string, approved: boolean) => runtime.respondClientRun(requestId, approved))

  // —— 长期记忆 ——
  ipcMain.handle('memory:list', async (_e, sessionId: string) => runtime.listMemory(sessionId))
  ipcMain.handle('memory:remove', async (_e, id: number) => runtime.removeMemory(id))

  // —— 通用设置 ——
  ipcMain.handle('settings:get', async () => runtime.getSettings())
  ipcMain.handle('settings:set', async (_e, patch: Partial<import('@shanhai/runtime').AppSettings>) => runtime.setSettings(patch))

  // —— HTTP 原始请求/响应记录（排查问题用，含接口地址与完整 body）——
  ipcMain.handle('trace:http-list', async (_e, id?: string) => runtime.getHttpTrace(id))
  ipcMain.handle('trace:http-clear', async (_e, id?: string) => runtime.clearHttpTrace(id))
  ipcMain.on('trace:http-path', (e, id?: string) => {
    e.returnValue = runtime.getHttpTracePath(id)
  })

  // —— 打开日志文件所在目录（在系统文件管理器中展示）——
  ipcMain.handle('trace:open-dir', async () => {
    const dir = runtime.getTraceDir()
    await shell.openPath(dir)
    return dir
  })

  // —— 聊天 ——
  ipcMain.handle('chat:run', async (_e, message: string, attachments?: Array<Record<string, unknown>>) => {
    try {
      return await runtime.run(message, { attachments: attachments as never })
    } catch (err) {
      // 统一记录完整错误便于排查；__retry_exhausted__ 等带语义的错误原样抛给渲染进程识别（弹重试/取消窗）
      console.error('[ipc] chat:run 失败:', err)
      throw err
    }
  })
  ipcMain.handle('chat:resend', async (_e, sessionId: string, userMessageIndex: number, newContent?: string) =>
    runtime.resend(sessionId, userMessageIndex, newContent),
  )
  ipcMain.handle('chat:resume', async (_e, sessionId: string) => runtime.resume(sessionId))
  ipcMain.handle('chat:retry', async (_e, sessionId: string) => runtime.retrySession(sessionId))
  ipcMain.handle('chat:abandon', async (_e, sessionId: string) => runtime.abandonSession(sessionId))
  ipcMain.handle('chat:inject', async (_e, sessionId: string, message: string) => runtime.injectMessage(sessionId, message))
  ipcMain.handle('chat:stop', async () => runtime.stop())

  // —— 会话管家（主 Agent，独立 supervisor 窗口）——
  ipcMain.handle('supervisor:run', async (_e, message: string, attachments?: Array<Record<string, unknown>>) => {
    try {
      return await runtime.runSupervisor(message, attachments as never)
    } catch (err) {
      // 统一记录完整错误便于排查；__retry_exhausted__ 等带语义的错误原样抛给渲染进程识别（弹重试/取消窗）
      console.error('[ipc] supervisor:run 失败:', err)
      throw err
    }
  })
  ipcMain.handle('supervisor:history', async () => runtime.getSessionHistory(SUPERVISOR_ID))
  // 管家自己的模型 / 安全模式（supervisor 会话级，独立于其他会话与全局）
  ipcMain.handle('supervisor:getModel', async () => runtime.getSupervisorModel())
  ipcMain.handle('supervisor:getApproval', async () => runtime.getSupervisorApprovalPolicy())
  ipcMain.handle('supervisor:setModel', async (_e, id: string) => runtime.setSupervisorModel(id))
  ipcMain.handle('supervisor:setApproval', async (_e, policy: 'ask' | 'workdir' | 'never') => runtime.setSupervisorApprovalPolicy(policy))
  // 管家窗口 ↔ 悬浮图标：关闭→显示图标 / 点击图标→恢复窗口 / 拖动图标移动
  ipcMain.handle('supervisor:hideToBubble', async () => hideSupervisorToBubble())
  ipcMain.handle('supervisor:showFromBubble', async () => showSupervisorFromBubble())
  ipcMain.on('supervisor:moveBubble', (_e, dx: number, dy: number) => moveSupervisorBubble(dx, dy))

  // —— 模型 ——
  ipcMain.handle('model:switch', async (_e, id: string) => runtime.switchModel(id))
  ipcMain.handle('model:current', async () => runtime.getCurrentModelId())
  ipcMain.handle('model:addCustom', async (_e, input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }) =>
    runtime.addCustomModel(input),
  )
  ipcMain.handle('model:updateCustom', async (_e, id: string, input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }) =>
    runtime.updateCustomModel(id, input),
  )
  ipcMain.handle('model:removeCustom', async (_e, id: string) => runtime.removeCustomModel(id))

  // —— token 用量 ——
  ipcMain.handle('token:stats', async (_e, sessionId?: string) => runtime.getTokenStats(sessionId))

  // —— 语音 ——
  ipcMain.handle('voice:speak', async (_e, text: string) => {
    await runtime.voice.synthesize(text)
  })
  ipcMain.handle('voice:transcribe', async (_e, audioBase64: string, format?: string) => runtime.transcribeAudio(audioBase64, format))

  // —— 系统目录选择器 ——
  ipcMain.handle('dialog:selectDirectory', async (e, defaultPath?: string) => {
    const options: Electron.OpenDialogOptions = {
      title: '选择工作目录',
      defaultPath: defaultPath || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
    }
    // 以「发起请求的主窗口」为父窗口（而非 getAllWindows()[0]，避免拿到先创建的浏览器窗口导致其被激活/显示）
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // —— 窗口管理（多窗口桌面系统：打开/关闭插件应用窗口）——
  ipcMain.handle('window:openApp', async (_e, appId: string) => openApp(appId))
  ipcMain.handle('window:closeApp', async (_e, appId: string) => closeApp(appId))
  // 桌面被点击后把聊天/app 窗口带回桌面之上（fire-and-forget，减少往返延迟）
  ipcMain.on('window:restoreAboveDesktop', () => restoreAboveDesktop())
  // 隐藏聊天窗口（自定义关闭按钮，聊天窗口常驻不销毁）
  ipcMain.handle('window:hideChat', async () => hideChatWindow())
  // 隐藏发起请求的窗口（常驻窗口如 supervisor 的自定义关闭按钮：close 事件已 preventDefault 只 hide）
  ipcMain.handle('window:hideSelf', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.hide()
  })
  // 最小化 / 最大化还原（自定义标题栏按钮，按发起请求的窗口定位，支持多开 app 窗口）
  ipcMain.on('window:minimize', (e) => minimizeWindow(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('window:toggleMaximize', (e) => toggleMaximizeWindow(BrowserWindow.fromWebContents(e.sender)))
  // Dock 窗口根据图标栏内容自适应尺寸（渲染进程测量后回调，fire-and-forget）
  ipcMain.on('window:resizeDock', (_e, width: number, height: number) => resizeDockWindow(width, height))
  // 退出到桌面：隐藏所有山海窗口回到系统界面，应用后台运行（托盘/快捷键恢复）
  ipcMain.handle('window:hideToDesktop', async () => hideToSystemDesktop())

  // —— 主题切换（亮/暗）：聊天窗口切换后广播给所有窗口，让各独立窗口（会话管家/Dock/桌面壳/应用窗口）实时跟随 ——
  ipcMain.on('theme:set', (_e, theme: 'light' | 'dark') => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('ui:theme', theme)
    }
  })

  // —— 全局 UI 共享状态（多窗口桌面系统：跨窗口上下文）——
  // 读取按发起窗口类型过滤：desktop 只拿登录态+壁纸，dock/supervisor-bubble 拿空快照，chat/supervisor/app 拿完整快照
  ipcMain.handle('ui:getState', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const type = win ? getWindowType(win) : undefined
    return filterUiStateForWindow(type, getUiState())
  })
  ipcMain.handle('ui:patch', async (_e, patch: Partial<UiStoreState>) => patchUiState(patch))

  // —— 桌面壁纸（独立持久化到 userData/wallpaper.json，跨窗口广播）——
  ipcMain.handle('wallpaper:get', async () => getWallpaper())
  ipcMain.handle('wallpaper:set', async (_e, wallpaper: string | null) => {
    setWallpaper(wallpaper)
    patchUiState({ wallpaper })
    return wallpaper
  })
  // —— 系统壁纸（macOS 自带高清 HEIC，经 sips 转码后纳入选择）——
  ipcMain.handle('wallpaper:listSystem', async () => listSystemWallpapers())
  ipcMain.handle('wallpaper:applySystem', async (_e, sourcePath: string) => {
    const wallpaper = await applySystemWallpaper(sourcePath)
    setWallpaper(wallpaper)
    patchUiState({ wallpaper })
    return wallpaper
  })

  // —— 远程连接（手机端跨端连接：局域网 WebSocket + 配对码鉴权）——
  ipcMain.handle('remote:enable', async (_e, port?: number) => startRemoteServer(port))
  ipcMain.handle('remote:disable', async () => {
    stopRemoteServer()
    return getRemoteStatus()
  })
  ipcMain.handle('remote:status', async () => getRemoteStatus())

  // —— 远程连接（网关中继，外网可达：桌面端作为 Host 连网关，手机同账号登录作为 Client 自动配对）——
  ipcMain.handle('remote:relayEnable', async (_e, url?: string) => startRemoteRelay(url))
  ipcMain.handle('remote:relayDisable', async () => {
    stopRemoteRelay()
    return getRelayStatus()
  })
  ipcMain.handle('remote:relayStatus', async () => getRelayStatus())

  // —— 应用版本更新（复用网关公开版本检查 API，手动检查 + 自动调度推送）——
  ipcMain.handle('app:get-version', async () => app.getVersion())
  ipcMain.handle('app:check-update', async (e) =>
    checkAndPromptForUpdate({ manual: true, parentWindow: BrowserWindow.fromWebContents(e.sender) }),
  )
  ipcMain.handle('app:get-update-status', async () => getLastUpdateCheckResult())
  ipcMain.handle('mobile:get-apk-info', async (_e, packageName: string) => fetchMobileApkInfo(packageName))
}
