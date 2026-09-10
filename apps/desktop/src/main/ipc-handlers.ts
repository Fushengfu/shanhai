import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { SUPERVISOR_ID } from '@shanhai/runtime'
import { safeSend } from './safe-send'
import { syncLocaleFromSettings } from './locale-store'
import { getRuntime } from './runtime'
import { openApp, closeApp, restoreAboveDesktop, hideChatWindow, minimizeWindow, toggleMaximizeWindow, resizeDockWindow, hideSupervisorToBubble, showSupervisorFromBubble, moveSupervisorBubble, hideToSystemDesktop, getWindowType, getWindowAppId, getDockTopOffset, setAppMenuWindowVisible } from './window-manager'
import { getPluginApp, listPluginApps, resolvePluginIconDataUrl } from './plugin-apps'
import { listDockPluginApps, beginPluginDrag, cancelPluginDrag, completePluginDrag } from './dock-plugins'
import { getUiState, getUiStateRev, patchUiState, getWallpaper, setWallpaper, filterUiStateForWindow, filterUiStateForPlugin, type UiStoreState } from './ui-store'
import { listSystemWallpapers, applySystemWallpaper } from './system-wallpaper'
import { startRemoteServer, stopRemoteServer, getRemoteStatus, refreshPairingCode } from './remote-server'
// 期6 扫尾：dialog.showOpenDialog 的 title 是 macOS 原生面板标题（用户可见），
// 与期5A 的 Dock/托盘/右键菜单同类 → 走 getMainLocale()+tIn，不走渲染层。
import { getMainLocale } from './locale-store'
import { tIn } from '../shared/i18n'
import { startRemoteRelay, stopRemoteRelay, getRelayStatus } from './remote-relay'
import { startCredentialRenewal, stopCredentialRenewal, getCredentialSnapshot, describeCredentialState } from './member-credentials'
import {
  startMemberChannel,
  stopMemberChannel,
  retryMemberChannel,
  getMemberStatus,
  getFriendsSnapshot,
  refreshFriends,
  searchMembers,
  requestFriend,
  acceptFriend,
  rejectFriend,
  deleteFriend,
  subscribeChannel,
  unsubscribeChannel,
  dropWindowSubscriptions,
  resolveDmChannelId,
  listThreads,
  pullThreads,
  getHistory,
  sendDm,
  sendDmFromAgent,
  markChannelRead,
  getUnread,
  quoteDmToSession,
} from './member-channel'
import { checkAndPromptForUpdate, getLastUpdateCheckResult, getLastDownloadProgress, cancelUpdateDownload, fetchMobileApkInfo } from './app-updater'
import { listMarketPlugins, downloadAndInstallPlugin, submitPluginToMarket, listMyPlugins, uninstallMarketPlugin } from './marketplace'
import { listSkills, listMcpServers, listMcpToolCounts, refreshSkills, uninstallSkill } from './skills-mcp'
import { listManagedServers, saveServer, setServerEnabled } from './mcp-config'
import { searchMarket, previewSkill, installFromMarket } from './skills-market'

/**
 * 渲染进程 → 主进程 调用（IPC handler）。
 * 按业务域分组：认证 / 会话 / 审批 / 聊天 / 模型 / 用量 / 语音 / 电脑 / 目录选择。
 * 每个 handler 只做参数透传 + 调 runtime 对应能力，业务逻辑都在 @shanhai/runtime 内。
 */
export function registerIpc(): void {
  const runtime = getRuntime()

  // —— 认证 ——
  ipcMain.handle('auth:status', async () => ({ loggedIn: runtime.loggedIn, username: runtime.username, avatar: runtime.avatar }))
  ipcMain.handle('auth:login', async (_e, u: string, p: string) => {
    const result = await runtime.login(u, p)
    // 登录成功后自动开启远程连接（外网中继 + 局域网），不再依赖手动开关
    startRemoteRelay()
    startRemoteServer()
    // 会员通道（私信/好友）与登录态同生命周期：登录即连（role=member 独立第二条连接）
    startMemberChannel()
    // 凭证续签与登录态同生命周期：登录后启动到期前自动续签（含「启动即已过期」的立即检查）
    startCredentialRenewal()
    return result
  })
  ipcMain.handle('auth:register', async (_e, u: string, p: string, nickname?: string, phone?: string, email?: string) => {
    const result = await runtime.register(u, p, nickname, phone, email)
    // 注册成功即登录：自动开启远程连接（外网中继 + 局域网）
    startRemoteRelay()
    startRemoteServer()
    startMemberChannel()
    startCredentialRenewal()
    return result
  })
  ipcMain.handle('auth:logout', async () => {
    await runtime.logout()
    // 退出登录自动关闭远程连接（外网中继 + 局域网）与会员通道（私信/好友）
    stopRemoteRelay()
    stopRemoteServer()
    stopMemberChannel()
    // 退出登录必须清理续签定时器（否则登出后仍在后台拿旧凭证打网关）
    stopCredentialRenewal()
  })
  // 凭证三态快照（未登录 / 已登录有效 / 已登录但已过期）：只给状态，绝不给 token 本体
  ipcMain.handle('auth:credentialStatus', async () => ({ ...getCredentialSnapshot(), text: describeCredentialState(getCredentialSnapshot()) }))
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
  // 通用文件上传（私信文档类附件用）：转发到 runtime 既有的 uploadFile（会员 JWT 换凭证 → 七牛直传）。
  // 会员 JWT 只在主进程，渲染层拿不到凭证 —— 这是本期唯一批准新增的主进程能力。
  ipcMain.handle('file:upload', async (_e, dataBase64: string, mimeType?: string, fileName?: string) => runtime.uploadFile(dataBase64, mimeType, fileName))
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
  ipcMain.handle('approval:getPolicy', async (_e, sid?: string) => runtime.getApprovalPolicy(sid))
  ipcMain.handle('approval:setPolicy', async (_e, policy: 'ask' | 'workdir' | 'never') => runtime.setApprovalPolicy(policy))

  // —— 能力级审批（插件跨插件调用 write/destructive 能力）：允许/拒绝回传 runtime resolve ——
  ipcMain.handle('capability-approval:respond', async (_e, requestId: string, approved: boolean, rememberForSession?: boolean) =>
    runtime.respondCapabilityApproval(requestId, approved, rememberForSession),
  )

  // —— AI 向用户提问（单选/多选/填空/选择器）——
  ipcMain.handle('ask:respond', async (_e, requestId: string, answer: string) => runtime.respondAsk(requestId, answer))
  ipcMain.handle('ask:cancel', async (_e, requestId: string) => runtime.cancelAsk(requestId))

  // —— 自修改（K5）——
  ipcMain.handle('selfmod:inspect', async (_e, sessionId?: string) => runtime.selfmodInspect(sessionId))
  ipcMain.handle('selfmod:respond', async (_e, requestId: string, approved: boolean) => runtime.respondClientRun(requestId, approved))

  // —— 动态插件窗口应用（app 窗口打开时查询 client 半源码，new Function 编译渲染）——
  ipcMain.handle('plugin-app:get', async (_e, appId: string) => getPluginApp(appId) ?? null)
  ipcMain.handle('plugin-app:list', async () => listPluginApps())
  ipcMain.handle('plugin-app:icon', async (_e, appId: string) => resolvePluginIconDataUrl(appId) ?? null)

  // —— Dock 手动固定插件（安装不自动上 Dock，改手动从桌面拖拽添加）——
  ipcMain.handle('dock-plugin:list', async () => listDockPluginApps())
  ipcMain.on('dock-plugin:drag-start', (_e, appId: string) => beginPluginDrag(appId))
  ipcMain.on('dock-plugin:drag-cancel', () => cancelPluginDrag())
  ipcMain.handle('dock-plugin:drag-complete', async () => completePluginDrag())

  // —— 长期记忆 ——
  ipcMain.handle('memory:list', async (_e, sessionId: string) => runtime.listMemory(sessionId))
  ipcMain.handle('memory:remove', async (_e, id: number) => runtime.removeMemory(id))

  // —— 本机技能 / MCP（账号悬停弹窗的只读展示，见 main/skills-mcp.ts）——
  // 全部只读；MCP 工具数探测带 5s 超时与逐台降级，拿不到就回 error，不编数字。
  ipcMain.handle('skills:list', async () => listSkills())
  ipcMain.handle('mcp:servers', async () => listMcpServers())
  ipcMain.handle('mcp:tool-counts', async () => listMcpToolCounts())

  // —— MCP 管理（编辑 / 启停，见 main/mcp-config.ts）——
  // 与上面三条只读通道分开：这两条会**写 `~/.shanhai/mcp.json`**。
  // 凭证红线：下发只给 env 的键名 + 常量掩码；收上来用 value:null 表示「保持原值」，原值不回传
  // （渲染层只拿得到掩码，物理上构造不出原值）。写盘原子（tmp + rename）且写前留 .bak。
  // 停用 = 把条目移到 `disabledServers` 段 —— McpService 只读 servers 段，故对 AI 侧是真不可见。
  ipcMain.handle('mcp:manage-list', async () => listManagedServers())
  ipcMain.handle('mcp:manage-save', async (_e, patch: unknown) => saveServer((patch ?? {}) as never))
  ipcMain.handle('mcp:manage-set-enabled', async (_e, id: string, enabled: boolean) => setServerEnabled(String(id ?? ''), !!enabled))

  // —— 技能市场（第三方市场搜索 / 详情审计 / 下载安装，见 main/skills-market.ts）——
  // 与上面的「本机只读清单」分开：这三条会**访问公网**并**写磁盘**（skills:market-install）。
  // 安装是危险动作，故：① 必须传确认标志才能装高风险技能；② 装完刷新本机技能缓存（refreshSkills）；
  // ③ 进度经 e.sender 只回发给发起安装的那个窗口（不外广播，避免别的窗口莫名出现进度条）。
  ipcMain.handle('skills:market-search', async (_e, query: string, source?: string, category?: string) =>
    searchMarket(String(query ?? ''), source === 'clawhub' || source === 'skillhub' ? source : 'all', category ? String(category) : undefined),
  )
  ipcMain.handle('skills:market-preview', async (_e, source: string, slug: string) => {
    try {
      if (source !== 'clawhub' && source !== 'skillhub') return { error: '未知的技能市场来源' }
      return await previewSkill(source, String(slug ?? ''))
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('skills:market-install', async (e, payload: { source: unknown; slug: unknown; confirmRisk?: unknown }) => {
    const result = await installFromMarket(payload ?? { source: '', slug: '' }, (p) => {
      // 只回发给发起安装的窗口；safeSend 会在窗口已销毁时不抛错
      const win = BrowserWindow.fromWebContents(e.sender)
      if (win) safeSend(win, 'skills:market-progress', p)
    })
    // 装成功就刷新本机技能清单的缓存实例，否则账号弹窗仍显示装之前的列表
    if (result.ok) refreshSkills()
    return result
  })

  // —— 技能卸载（技能市场「已安装」tab，见 main/skills-mcp.ts 的 uninstallSkill）——
  // 与安装对称的破坏性动作：主进程侧做「id 合法性 + 只能删 user 技能 + 路径夹取在
  // ~/.shanhai/skills 之内 + realpath 复核」四道校验，任何一步不过就如实回 error 且不删任何东西；
  // 成功后 uninstallSkill 内部已调 refreshSkills()（本处不重复调）。
  ipcMain.handle('skills:uninstall', async (_e, id: string) => uninstallSkill(String(id ?? '')))

  // —— 通用设置 ——
  ipcMain.handle('settings:get', async () => runtime.getSettings())
  ipcMain.handle('settings:set', async (_e, patch: Partial<import('@shanhai/runtime').AppSettings>) => {
    const next = await runtime.setSettings(patch)
    // 【i18n 期1】语言变了要广播给所有窗口（照 theme:set → ui:theme 的形态）。
    // 刻意不新开 locale:set 通道：写设置已有现成通道，再开一条就是同一份数据两条路（第二套真相源），
    // 而且会让 ipcMain.handle 计数从 125 涨上去（历轮台账锁的就是 125）。
    if (patch && typeof patch.locale === 'string') syncLocaleFromSettings(next.locale)
    return next
  })

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
  // 停止执行：不传 sessionId 保持原语义（停「当前激活会话」，聊天窗口用）；传了则按 id 精确停。
  // ⚠️ 管家窗口必须显式传 SUPERVISOR_ID：runtime.stop() 停的是 ctx.currentSessionId，而
  //   switchSessionInternal 明确拒绝把管家会话设为当前会话（apps/runtime/src/sessions.ts:396
  //   `if (!target || target.isSupervisor) return { ok: false, ... }`）→ currentSessionId 恒不等于
  //   'supervisor' → 管家窗口的「停止」从来没停到管家自己（这就是「点暂停还在后台继续执行」的根因）。
  //   信任面未扩大：同族的 chat:resume / chat:retry / chat:inject / chat:resend 本来就接受任意 sessionId。
  ipcMain.handle('chat:stop', async (_e, sessionId?: string) => {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    // ★任务194 ⑦-②：旧写法无 return ⇒ 渲染层拿不到成败（只能靠 rejected promise 猜）。现在把
    //   成/败 + 原因结构化回传。不新增 IPC 通道（仍只有这一个 chat:stop）、不改 preload 参数形态
    //   （invoke 本就回传 resolve 值）、不改 runtime 的 stop()/stopSession() 签名（它们仍是 void）。
    //   ⚠️ catch 到的正是任务193 P3-c 在「游标为 null」时抛的错：这里转成结构化失败是为了带上原因，
    //   不是把失败吞掉 —— 渲染层（App.tsx / SupervisorApp.tsx）必须把 reason 显示出来。
    try {
      if (sid) {
        runtime.stopSession(sid)
        return { ok: true as const, sessionId: sid, explicit: true }
      }
      runtime.stop()
      // 无参分支：停的是主进程游标指向的会话，这里回不到具体 id（runtime 不暴露该游标），
      // 故只回 explicit:false；界面一律用既有 listSessions() 真值回读判定「是否真停」。
      return { ok: true as const, explicit: false }
    } catch (err) {
      return { ok: false as const, sessionId: sid || undefined, explicit: sid.length > 0, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  // —— 会话管家（主 Agent，独立 supervisor 窗口）——
  ipcMain.handle('supervisor:run', async (_e, message: string, attachments?: Array<Record<string, unknown>>, dmContext?: { channelId?: string; peerMemberId?: string; fromName?: string }) => {
    try {
      return await runtime.runSupervisor(message, attachments as never, dmContext as never)
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
  // ⚠️ 关闭必须把「发起窗口」（e.sender）传给主进程：注册表里若因历史 bug 残留多个 supervisor 条目，
  // 「按类型找第一个」会关掉用户没点的那个，表现就是「点关闭没反应」。按发起窗口关才可靠。
  ipcMain.handle('supervisor:hideToBubble', (e) => hideSupervisorToBubble(BrowserWindow.fromWebContents(e.sender) ?? undefined))
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
      title: tIn(getMainLocale(), 'native.dialog.selectWorkDir'),
      defaultPath: defaultPath || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
    }
    // 以「发起请求的主窗口」为父窗口（而非 getAllWindows()[0]，避免拿到先创建的浏览器窗口导致其被激活/显示）
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    // 【任务166】原生面板关闭后必须纠正窗口层级：macOS 上 showOpenDialog(win) 以 sheet 挂在发起窗口上，
    // 面板（含取消）关闭后，全屏桌面壳可能因焦点变化被抬到发起窗口【之上】，表现为「选完目录整个子会话窗口
    // 被隐藏」（实际是被壁纸大小的桌面壳盖住，不是 hide()——本仓该路径不存在任何 hide 调用）。
    // 修法沿用 closeApp 的既有口径：交还给单一真相源 restoreAboveDesktop()（内部 ensureDesktopLayer +
    // keepDesktopAtBottom），不新增 hide/show 通路、不改选择器交互形态；它只抬升【已可见】窗口，
    // 因此若窗口真是被 hide() 也不会被它"救回来"，不会掩盖真正的隐藏。
    restoreAboveDesktop()
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // —— 窗口管理（多窗口桌面系统：打开/关闭插件应用窗口）——
  /**
   * 【任务223】应用窗口的「目标会话」校验（唯一入口，主进程侧唯一真相源）。
   *
   * 为什么必须校验：该值会被拼进窗口的 additionalArguments 交给渲染进程，并直接决定
   * MemoryPanel/TracePanel 去查哪个会话的数据 —— 放行任意字符串等于把「查任意会话数据」
   * 的入口开放给渲染层，且会让窗口注入了不属于会话标识的垃圾参数。
   *
   * 放行规则（只有两类，其余一律回落 undefined）：
   * - 'supervisor'：内置超级会话，恒定存在；listSessions 刻意过滤掉它，故必须单独放行。
   * - 其余必须命中 runtime.listSessions() 的真实会话 id（不存在的 id 一律拒绝）。
   * 回落成 undefined = 不注入 argv 参数 = 窗口内读 currentSessionId，与本改动前行为一致，
   * 既不报错也不静默显示错的数据。
   */
  const normalizeAppSessionId = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined
    const sid = raw.trim()
    if (!sid || sid.length > 128) return undefined
    if (sid === SUPERVISOR_ID) return sid
    return runtime.listSessions().some((s) => s.id === sid) ? sid : undefined
  }
  ipcMain.handle('window:openApp', async (_e, appId: string, sessionId?: unknown) => openApp(appId, normalizeAppSessionId(sessionId)))
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
  ipcMain.handle('window:hideToDesktop', async () => {
    hideToSystemDesktop()
    // 【任务187】app-menu 浮层也在「隐藏全部窗口」的循环里被收掉，但共享状态里的 appMenuOpen
    // 必须跟着复位：否则 Dock 按钮仍显示"已打开"，用户再点一次只是把 true 改成 false（屏幕上什么都不发生），
    // 要点第二次才开得了 —— 正是本任务禁止的「点了没反应」失败分支。
    patchUiState({ appMenuOpen: false })
  })
  // 获取 Dock 顶部距桌面壳底部的距离（应用菜单面板据此定位在 Dock 上方弹出）
  ipcMain.handle('window:getDockTop', async () => getDockTopOffset())
  // 【任务187·方案 P】应用菜单浮层开/关：主进程是唯一写者（同时切窗口可见态 + 写回共享状态），
  // 渲染层不再各自 patchUiStore({appMenuOpen})，避免「Dock 以为开着 / 浮层其实已关」两份真相。
  ipcMain.handle('window:setAppMenu', async (_e, open: boolean) => {
    const visible = setAppMenuWindowVisible(!!open)
    patchUiState({ appMenuOpen: visible })
    return visible
  })

  // —— 主题切换（亮/暗）：聊天窗口切换后广播给所有窗口，让各独立窗口（会话管家/Dock/桌面壳/应用窗口）实时跟随 ——
  ipcMain.on('theme:set', (_e, theme: 'light' | 'dark') => {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win, 'ui:theme', theme)
    }
  })

  // —— 全局 UI 共享状态（多窗口桌面系统：跨窗口上下文）——
  // 读取按发起窗口类型过滤：desktop 只拿登录态+壁纸，dock/supervisor-bubble 拿空快照，chat/supervisor/app 拿完整快照
  ipcMain.handle('ui:getState', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const type = win ? getWindowType(win) : undefined
    return { rev: getUiStateRev(), state: filterUiStateForWindow(type, getUiState()) }
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
  ipcMain.handle('remote:refreshCode', async () => refreshPairingCode())

  // —— 远程连接（网关中继，外网可达：桌面端作为 Host 连网关，手机同账号登录作为 Client 自动配对）——
  ipcMain.handle('remote:relayEnable', async (_e, url?: string) => startRemoteRelay(url))
  ipcMain.handle('remote:relayDisable', async () => {
    stopRemoteRelay()
    return getRelayStatus()
  })
  ipcMain.handle('remote:relayStatus', async () => getRelayStatus())

  // 窗口被销毁时回收它持有的通道订阅（并向网关发 leave），避免死窗口的订阅 id 堆积、通道长期挂着
  app.on('web-contents-created', (_e, contents) => {
    contents.on('destroyed', () => dropWindowSubscriptions(contents.id))
  })

  // —— 会员实时通讯底座（私信 / 好友）——
  // 内置侧专用：走普通 ipcMain.handle，与插件白名单 plugin:invoke 完全无关（本轮插件不接入通道）。
  // 凭证（memberToken）只在主进程 member-channel.ts 内使用，渲染层拿不到 token，只拿状态与消息数据。
  ipcMain.handle('member:status', async () => getMemberStatus())
  ipcMain.handle('member:retry', async () => retryMemberChannel())
  // 好友列表 / 检索 / 申请 / 会话列表 / 历史 / 已读：定稿契约全部走 HTTP（主进程持 JWT，渲染层拿不到凭证）
  ipcMain.handle('member:freshFriends', async () => refreshFriends())
  ipcMain.handle('member:friends', async () => getFriendsSnapshot())
  ipcMain.handle('member:threads', async () => listThreads())
  ipcMain.handle('member:pullThreads', async () => pullThreads())
  ipcMain.handle('member:unread', async () => getUnread())
  ipcMain.handle('member:search', async (_e, username: string) => searchMembers(String(username ?? '')))
  ipcMain.handle('member:requestFriend', async (_e, input: { targetMemberId: string; message?: string }) => requestFriend(input ?? { targetMemberId: '' }))
  ipcMain.handle('member:acceptFriend', async (_e, targetMemberId: string) => acceptFriend(String(targetMemberId ?? '')))
  ipcMain.handle('member:rejectFriend', async (_e, targetMemberId: string) => rejectFriend(String(targetMemberId ?? '')))
  ipcMain.handle('member:deleteFriend', async (_e, memberId: string) => deleteFriend(String(memberId ?? '')))
  ipcMain.handle('member:subscribe', async (e, channelId: string) => subscribeChannel(String(channelId ?? ''), e.sender.id))
  // 1v1 通道 id 由主进程算（本账号 memberId 只在主进程可见，渲染层不自己拼字符串）
  ipcMain.handle('member:channelId', async (_e, peerMemberId: string) => resolveDmChannelId(String(peerMemberId ?? '')))
  ipcMain.handle('member:unsubscribe', async (e, channelId: string) => unsubscribeChannel(String(channelId ?? ''), e.sender.id))
  // 定稿 v1.1：历史是 page/pageSize 偏移分页（page=1 最新一页，加载更早=page 递增），不是时间戳游标
  ipcMain.handle('member:history', async (_e, input: { channelId: string; page?: number; pageSize?: number }) => getHistory(input))
  // 【任务109】消息卡片「分享到好友」带 fromUserShare 标志 → 转调 sendDmFromAgent：
  // 与管家 dm_send **同一份实现、同一道出站敏感过滤**，不走裸 sendDm（那样等于绕过安全门）。
  // ★本轮不新增 ipcMain.handle / IPC 通道 / preload 方法，只在既有 member:send 的入参上扩一个可选字段。
  // 该标志只有内置渲染层能构造：插件窗口挂的是 preload/plugin.cjs（只暴露 window.shanhaiPlugin 白名单桥），
  // 拿不到 window.shanhai.memberSend，故外部/插件路径无法伪造。
  ipcMain.handle('member:send', async (_e, input: { peerMemberId?: string; channelId?: string; text: string; peerName?: string; fromUserShare?: boolean }) =>
    input?.fromUserShare ? sendDmFromAgent(input) : sendDm(input ?? { text: '' }),
  )
  // 【管家接管私信】管家/Agent 以当前会员身份发私信：进 sendDmFromAgent 的安全门（dmAutoReply 开关 + 出站敏感信息硬拦截）。
  // 允许新增这一条 handler（ipcMain.handle 125→126）；不进插件窗口白名单（危险接口，永不放行给插件）。
  ipcMain.handle('member:send-from-agent', async (_e, input: { channelId?: string; peerMemberId?: string; text: string; replyTo?: string }) =>
    sendDmFromAgent(input ?? { text: '' }),
  )
  ipcMain.handle('member:markRead', async (_e, channelId: string) => markChannelRead(String(channelId ?? '')))
  // 【红线入口】把某条私信引用到指定会话的输入框：必须由本地用户在私信面板显式点击才会走到这里，
  // 主进程只把带来源标记的文本投给聊天窗口写进输入框，不触发任何执行、不进任何 Agent 上下文。
  ipcMain.handle('member:quoteToSession', async (e, input: { sessionId: string; channelId: string; msgId: string }) =>
    quoteDmToSession(input ?? { sessionId: '', channelId: '', msgId: '' }, e.sender.id),
  )

  // —— 应用版本更新（复用网关公开版本检查 API，手动检查 + 自动调度推送）——
  ipcMain.handle('app:get-version', async () => app.getVersion())
  ipcMain.handle('app:check-update', async (e) =>
    checkAndPromptForUpdate({ manual: true, parentWindow: BrowserWindow.fromWebContents(e.sender) }),
  )
  ipcMain.handle('app:get-update-status', async () => getLastUpdateCheckResult())
  // 安装包下载进度：供中途新开的窗口一次性拉取当前快照（实时增量走 app:update-download-progress 广播）
  ipcMain.handle('app:get-update-download-progress', async () => getLastDownloadProgress())
  // 取消正在进行的安装包下载（渲染层进度卡片上的「取消下载」按钮）
  ipcMain.handle('app:cancel-update-download', async () => cancelUpdateDownload())
  ipcMain.handle('mobile:get-apk-info', async (_e, packageName: string) => fetchMobileApkInfo(packageName))

  // —— 插件市场（公开列表 / 下载安装 / 提交）——
  ipcMain.handle('market:list', async (_e, params: { keyword?: string; category?: string; hasUI?: boolean | ''; page?: number; pageSize?: number }) =>
    listMarketPlugins(params ?? {}),
  )
  ipcMain.handle('market:install', async (_e, pluginId: string) => downloadAndInstallPlugin(pluginId))
  ipcMain.handle('market:submit', async (_e, pluginDirOrId: string, categories?: string[]) =>
    submitPluginToMarket(pluginDirOrId, categories),
  )
  ipcMain.handle('market:mine', async () => listMyPlugins())
  ipcMain.handle('market:uninstall', async (_e, pluginId: string) => uninstallMarketPlugin(pluginId))

  // —— 插件窗口白名单 IPC（第 1 步：插件专用 preload 的统一入口，双层校验）——
  // 第一层：插件窗口只能经专用 preload（window.shanhaiPlugin）调用，物理拿不到全量 window.shanhai；
  // 第二层：此处按「插件 id + 能力名」校验——反查发起窗口的插件 appId，能力必须在全局白名单内，
  //         且插件 manifest 声明的 permissions[] 里包含该能力，否则拒绝。危险接口（auth/chat/supervisor/
  //         model/remote/approval:setPolicy/session:delete/settings:set/wallpaper:set 等）永不进白名单。
  const PLUGIN_CAPABILITIES = new Set([
    'getVersion', 'clipboardWriteText', 'clipboardReadText', 'speak', 'selectDirectory',
    'listSessions', 'listMemory', 'getUiState', 'closeApp', 'getWallpaper', 'getTokenStats',
    'invokePluginService', 'modelCall', 'listModels', 'modelCallStream',
    'videoGen', 'videoGenQuery', 'imageGen', 'imageGenQuery', 'tts', 'uploadFile',
  ])
  ipcMain.handle('plugin:invoke', async (e, capability: string, ...args: unknown[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const appId = win ? getWindowAppId(win) : undefined
    if (!appId) throw new Error('插件能力调用缺少窗口上下文（仅插件窗口可调 window.shanhaiPlugin）')
    const pkg = getPluginApp(appId)
    if (!pkg) throw new Error(`未知插件应用: ${appId}`)
    if (!PLUGIN_CAPABILITIES.has(capability)) throw new Error(`能力不在插件白名单: ${capability}`)
    // closeApp 是「关闭自身窗口」的无害能力（appId 由窗口反查，无法越权关其它窗口），默认放行、不要求 permissions 声明：
    // 否则 AI 生成插件时若漏声明 closeApp，插件窗口将无法关闭（体验灾难）。其余能力仍需 permissions 显式声明。
    // invokePluginService 同理：它只能调「本插件」host 半注册的服务（appId 反查 + host 服务按插件 id 分组隔离），
    // 无法越权调其它插件/内核服务，属插件内部前后端通信，默认放行（不要求 permissions 声明）。
    const alwaysAllowed = capability === 'closeApp' || capability === 'invokePluginService'
    if (!alwaysAllowed && !pkg.permissions.includes(capability)) {
      throw new Error(`插件 "${pkg.name}" 未声明权限「${capability}」，请在其 manifest.permissions 中声明`)
    }
    switch (capability) {
      case 'getVersion':
        return app.getVersion()
      case 'clipboardWriteText':
        clipboard.writeText(String(args[0] ?? ''))
        return
      case 'clipboardReadText':
        return clipboard.readText()
      case 'speak':
        await runtime.voice.synthesize(String(args[0] ?? ''))
        return
      case 'selectDirectory': {
        const options: Electron.OpenDialogOptions = {
          title: tIn(getMainLocale(), 'native.dialog.selectDir'),
          defaultPath: (typeof args[0] === 'string' ? args[0] : '') || app.getPath('home'),
          properties: ['openDirectory', 'createDirectory'],
        }
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0]
      }
      case 'listSessions':
        return runtime.listSessions()
      case 'listMemory':
        return runtime.listMemory(String(args[0] ?? ''))
      case 'getUiState':
        // 精简版：只暴露登录态 + 用户名 + 壁纸，隔离 apiKey / 会话历史 / token 等敏感数据
        return filterUiStateForPlugin(getUiState())
      case 'closeApp':
        // 仅自身 id：插件只能关闭自己的窗口，无法越权关闭其它 app 窗口
        closeApp(appId)
        return
      case 'getWallpaper':
        return getWallpaper()
      case 'getTokenStats':
        return runtime.getTokenStats(typeof args[0] === 'string' ? args[0] : undefined)
      case 'invokePluginService':
        // client → host 自定义 RPC：appId 反查窗口 → 插件 id，只调「本插件」host 半注册的服务（无法越权）
        return runtime.invokePluginService(appId, String(args[0] ?? ''), Array.isArray(args[1]) ? args[1] : [])
      case 'modelCall':
        // 受控单次文本生成：modelId 可选（须在 listModelsForPlugin 可用列表内），缺省用当前选中模型；maxTokens 上限由 runtime 固定。
        return runtime.invokeModelForPlugin(appId, args[0] as { prompt: string; systemPrompt?: string; modelId?: string })
      case 'listModels':
        // 可用模型列表（精简 id + 展示名，隔离 apiKey/baseUrl 等敏感字段）
        return runtime.listModelsForPlugin()
      case 'modelCallStream': {
        // 受控流式文本生成：边生成边经 webContents 推送分片（chunk/usage/done/error），避免长文本一次性返回超时
        const payload = args[0] as { callId: string; prompt: string; systemPrompt?: string; modelId?: string }
        void (async () => {
          try {
            await runtime.invokeModelForPluginStream(appId, payload, (ev) => {
              e.sender.send('plugin:model-stream-event', { callId: payload.callId, ...ev })
            })
          } catch (err) {
            e.sender.send('plugin:model-stream-event', { callId: payload.callId, type: 'error', error: err instanceof Error ? err.message : String(err) })
          }
        })()
        return { ok: true, callId: payload.callId }
      }
      case 'videoGen':
        // 视频生成提交：透传网关 POST /api/v1/video/generations（真实接口已存在），返回 { taskId }
        return runtime.invokeVideoGen(appId, args[0] as { model?: string; prompt: string; duration: string | number; resolution?: string; ratio?: string; audio?: boolean | string; firstFrame?: { url?: string; base64?: string }; referenceImages?: Array<{ url?: string; base64?: string }>; seed?: number; promptExtend?: boolean; watermark?: boolean })
      case 'videoGenQuery':
        // 视频生成查询：透传网关 GET /api/v1/video/generations/{taskId}（真实接口已存在）
        return runtime.invokeVideoGenQuery(appId, args[0] as { taskId: string })
      case 'imageGen':
        // 图片生成提交：透传网关 POST /api/v1/image/generations（网关尚未实现，桥已预留）
        return runtime.invokeImageGen(appId, args[0] as { model?: string; prompt: string })
      case 'imageGenQuery':
        // 图片生成查询：透传网关 GET /api/v1/image/generations/{taskId}（网关尚未实现，桥已预留）
        return runtime.invokeImageGenQuery(appId, args[0] as { taskId: string })
      case 'tts':
        // 语音合成提交：透传网关 POST /api/v1/audio/tts（网关尚未实现，桥已预留）
        return runtime.invokeTts(appId, args[0] as { model?: string; text: string })
      case 'uploadFile': {
        // 插件上传素材/文件到七牛，返回公网 URL。凭证用「登录账号上传」（memberToken），与输入框图片上传同一体系。
        // 主进程持有凭证（memberToken），不暴露给插件；插件只提供文件 base64 + 可选 mimeType/fileName。
        const input = (args[0] ?? {}) as { dataBase64?: string; mimeType?: string; fileName?: string }
        if (!input?.dataBase64) throw new Error('uploadFile 需要 dataBase64 文件内容')
        const url = await runtime.uploadFile(input.dataBase64, input.mimeType, input.fileName)
        if (!url) throw new Error('上传文件失败：未登录或上传异常（请先登录再上传素材）')
        return url
      }
      default:
        throw new Error(`未实现的插件能力: ${capability}`)
    }
  })
}
