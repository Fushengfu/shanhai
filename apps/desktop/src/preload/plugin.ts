import { contextBridge, ipcRenderer } from 'electron'

/**
 * 插件应用窗口专用 preload（第 1 步：安全底座）。
 *
 * 与 index.ts（全量 window.shanhai，100+ IPC）不同，这里只暴露两个精简桥：
 *
 * 1. window.shanhai ——「宿主桥」：仅供山海自己的 AppWindow 渲染 client 半源码时使用，
 *    只含最小能力（windowType/platform/windowAppId + getPluginApp + closeApp）。不含任何危险业务接口。
 * 2. window.shanhaiPlugin ——「白名单桥」：插件 client 半可调用的公开能力，每个方法统一走主进程
 *    「plugin:invoke」入口，按「插件 id + 能力名」双层校验：能力必须在全局白名单内、且插件 manifest
 *    的 permissions[] 声明了该能力，否则抛错拒绝。
 *
 * 危险接口（auth:* / chat:run / supervisor:* / model:* / remote:* / approval:setPolicy /
 * session:delete / settings:set / wallpaper:set 等）在此物理不可见——插件窗口既拿不到全量
 * window.shanhai，也无法绕过白名单直接调用主进程。
 */

/** 从 additionalArguments 读取主进程注入的窗口类型/应用 id（sandbox 下 process.argv 仍含这些值） */
function readArg(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : undefined
}

const windowType: 'app' = 'app'
const windowAppId: string | undefined = readArg('--shanhai-app-id=')

/**
 * 宿主桥：插件窗口所需的最小能力。
 * getPluginApp 拉取插件应用元信息（只读）、closeApp 关闭自身窗口、minimizeWindow/toggleMaximizeWindow
 * 操作自身窗口（主进程按 sender 反查，无法越权操作其它窗口），均无害；危险接口不在此暴露。
 */
const hostBridge = {
  windowType,
  platform: process.platform,
  windowAppId,
  getPluginApp: (appId: string) => ipcRenderer.invoke('plugin-app:get', appId),
  closeApp: (appId: string) => ipcRenderer.invoke('window:closeApp', appId),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  /** 订阅主题变更（主进程 ui:theme 广播给所有窗口），返回取消订阅函数。插件窗口据此跟随内置应用亮/暗切换 */
  onThemeChange: (cb: (theme: 'light' | 'dark') => void): (() => void) => {
    const listener = (_e: unknown, theme: 'light' | 'dark') => cb(theme)
    ipcRenderer.on('ui:theme', listener)
    return () => ipcRenderer.removeListener('ui:theme', listener)
  },
}
contextBridge.exposeInMainWorld('shanhai', hostBridge)

/** 插件窗口可调用的白名单能力（与主进程 PLUGIN_CAPABILITIES 一一对应） */
export interface ShanhaiPluginBridge {
  /** 当前插件应用 id（持久化 id，由主进程 additionalArguments 注入） */
  pluginAppId?: string
  /** 应用版本号 */
  getVersion(): Promise<string>
  /** 写剪贴板 */
  clipboardWriteText(text: string): Promise<void>
  /** 读剪贴板 */
  clipboardReadText(): Promise<string>
  /** 语音播报（TTS） */
  speak(text: string): Promise<void>
  /** 打开目录选择器，返回所选目录绝对路径，取消返回 null */
  selectDirectory(defaultPath?: string): Promise<string | null>
  /** 列出用户会话（只读） */
  listSessions(): Promise<Array<{ id: string; title: string; workDir: string; lastActiveAt: number; busy: boolean }>>
  /** 列出指定会话的长期记忆（只读） */
  listMemory(sessionId: string): Promise<unknown[]>
  /** 精简 UI 状态（只含登录态 + 用户名 + 壁纸，隔离 apiKey/会话历史/token 等敏感数据） */
  getUiState(): Promise<{ loggedIn: boolean; username: string | null; wallpaper: string | null }>
  /** 关闭当前插件自己的窗口（仅自身，无法越权关其它窗口） */
  closeApp(): Promise<void>
  /** 读取桌面壁纸（CSS backgroundImage 值） */
  getWallpaper(): Promise<string | null>
  /** token 用量快照（只读） */
  getTokenStats(sessionId?: string): Promise<unknown>
  /**
   * 调用本插件 host 半注册的自定义服务（client → host RPC）。
   * 入参：服务名（host 半 ctx.provide 注册的 name）+ 可变参数；返回值必须是 JSON 可序列化数据。
   * 默认放行（无需 permissions 声明）；只能调「本插件」的服务，无法越权调其它插件/内核。
   */
  invokePluginService(name: string, ...args: unknown[]): Promise<unknown>
  /**
   * 模型调用（受控单次文本生成）：可指定 modelId（须在 listModels() 可用列表内），缺省用当前选中模型。
   * 需显式声明 permissions: ["modelCall"]；不能切模型（model:switch 仍物理隔离），单次 maxTokens 上限由主进程固定。
   * 入参 { prompt: 必填用户提示词, systemPrompt?: 可选系统提示词, modelId?: 可选模型 id }，返回 { text, usage? }。
   */
  modelCall(input: { prompt: string; systemPrompt?: string; modelId?: string }): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }>
  /** 列出可用模型（精简 id + 展示名 + 类型，隔离 apiKey/baseUrl 等敏感字段）。需显式声明 permissions: ["listModels"] */
  listModels(): Promise<Array<{ id: string; name: string; modelType?: string }>>
  /**
   * 流式模型调用（边生成边推送分片，适合长文本避免一次性返回超时）。
   * 需显式声明 permissions: ["modelCallStream"]；modelId 受控（须在 listModels 可用列表内）。
   * 入参 input { prompt, systemPrompt?, modelId? } + handlers { onChunk, onUsage, onDone, onError }，返回 { cancel }。
   */
  modelCallStream(input: { prompt: string; systemPrompt?: string; modelId?: string }, handlers: {
    onChunk?: (text: string) => void
    onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void
    onDone?: () => void
    onError?: (error: Error) => void
  }): { cancel: () => void }
  /**
   * 视频生成（提交）：透传网关 POST /api/v1/video/generations，返回 { taskId }。需显式声明 permissions: ["videoGen"]。
   * 入参契约（严格对齐网关）：{ model?, prompt, duration, resolution?, ratio?, audio?, firstFrame?, referenceImages?, seed?, promptExtend?, watermark? }。
   */
  videoGen(input: { model?: string; prompt: string; duration: string | number; resolution?: string; ratio?: string; audio?: boolean | string; firstFrame?: { url?: string; base64?: string }; referenceImages?: Array<{ url?: string; base64?: string }>; seed?: number; promptExtend?: boolean; watermark?: boolean }): Promise<{ taskId: string }>
  /** 视频生成查询：透传网关 GET /api/v1/video/generations/{taskId}，返回 { status, progress?, videoUrl?, errorMessage? }。需显式声明 permissions: ["videoGenQuery"]。 */
  videoGenQuery(input: { taskId: string }): Promise<{ status: string; progress?: number; videoUrl?: string; resultUrl?: string; videoUrlRaw?: string; errorMessage?: string }>
  /** 图片生成（提交）：透传网关 POST /api/v1/image/generations，返回 { taskId }。需显式声明 permissions: ["imageGen"]。 */
  imageGen(input: { model?: string; prompt: string; [key: string]: unknown }): Promise<{ taskId: string }>
  /** 图片生成查询：透传网关 GET /api/v1/image/generations/{taskId}，终态补调 /result 拿图地址。需显式声明 permissions: ["imageGenQuery"]。 */
  imageGenQuery(input: { taskId: string }): Promise<{ status: string; progress?: number; imageUrl?: string; resultUrl?: string; sourceUrl?: string; errorMessage?: string }>
  /** 语音合成（提交）：透传网关 POST /api/v1/audio/tts（网关尚未实现，桥已预留）。需显式声明 permissions: ["tts"]。 */
  tts(input: { model?: string; text: string; [key: string]: unknown }): Promise<unknown>
  /**
   * 【插件实时通讯】订阅一条通道（房间帧的下行落点）。
   * 需显式声明 permissions: ["netSubscribe"]。
   *
   * 通道 id 形如 `chat:1v1:{较小 memberId}-{较大 memberId}`（同一对会员在两台电脑上算出的值相同），
   * 插件用自己的方式拿到「对端会员标识」后与本机会员拼成该通道即可；主进程会**再次校验**该通道确实属于
   * 「本账号 ↔ 该好友」，不匹配直接拒绝。插件**无需**（也拿不到）本机会员标识 —— 校验全在内核侧完成。
   *
   * 返回 { ok, channelId?, error? }：error 取值 invalid_channel / too_many_channels 等（详见协议）。
   * ⚠️ 主进程**不会**返回任何 token / 凭证 —— 连接与鉴权全部由内核代理。
   */
  netSubscribe(channelId: string): Promise<{ ok: boolean; channelId?: string; error?: string }>
  /**
   * 【插件实时通讯】上行一帧（对局状态、操作指令等）。需显式声明 permissions: ["netSend"]。
   *
   * - 必须先 `netSubscribe` 过同一 channelId（且必须是本窗口订阅的），否则返回 error: not_subscribed；
   * - 单帧上限 8KB（超出返回 error: frame_too_large）；每个插件有独立的房间帧限流额度
   *   （与「私信 30 条 / 10 秒」**互不挤占**），超限返回 error: rate_limited；
   * - 只有互相加为好友才能收发（本地好友表 + 网关 friend_required 双重校验）。
   *
   * ⚠️ 帧内容**不会**落盘、**不会**进任何 Agent 会话上下文 —— 它只是一条实时数据帧。
   */
  netSend(input: { channelId: string; peerMemberId: string; payload: unknown }): Promise<{ ok: boolean; channelId?: string; error?: string }>
  /**
   * 【插件实时通讯】订阅下行房间帧。返回取消订阅函数。
   *
   * 回调载荷：`{ pluginId, channelId, from, payload, ts }`（`from` = 对端会员标识，`payload` = 对端发出的数据）。
   * **按 pluginId 过滤**：preload 只会把「pluginId 等于本插件自身 id」的帧交给你，
   * 其它插件的帧即使到了本窗口也不会回调（主进程侧投递隔离是第一道，这里是第二道）。
   * 与 `onThemeChange` 同形（返回 disposer），插件卸载/窗口关闭时无需额外处理。
   */
  onNetFrame(cb: (frame: { pluginId: string; channelId: string; from: string; payload: unknown; ts: number }) => void): (() => void)
  /**
   * 上传文件到七牛云，返回 https 公网 URL（供素材/图片直传，拿到公网链接后转给 videoGen 等）。
   * 凭证由主进程持有（登录账号 memberToken），插件只传文件 base64 + 可选 mimeType/fileName，拿不到 token/key。
   * 需显式声明 permissions: ["uploadFile"]；未登录返回错误。
   */
  uploadFile(input: { dataBase64: string; mimeType?: string; fileName?: string }): Promise<string>
}

/** 统一入口：所有能力走主进程 plugin:invoke 双层校验 */
const invoke = (capability: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke('plugin:invoke', capability, ...args)

const pluginBridge: ShanhaiPluginBridge = {
  pluginAppId: windowAppId,
  getVersion: () => invoke('getVersion') as Promise<string>,
  clipboardWriteText: (text) => invoke('clipboardWriteText', text) as Promise<void>,
  clipboardReadText: () => invoke('clipboardReadText') as Promise<string>,
  speak: (text) => invoke('speak', text) as Promise<void>,
  selectDirectory: (defaultPath) => invoke('selectDirectory', defaultPath) as Promise<string | null>,
  listSessions: () => invoke('listSessions') as Promise<Array<{ id: string; title: string; workDir: string; lastActiveAt: number; busy: boolean }>>,
  listMemory: (sessionId) => invoke('listMemory', sessionId) as Promise<unknown[]>,
  getUiState: () => invoke('getUiState') as Promise<{ loggedIn: boolean; username: string | null; wallpaper: string | null }>,
  closeApp: () => invoke('closeApp') as Promise<void>,
  getWallpaper: () => invoke('getWallpaper') as Promise<string | null>,
  getTokenStats: (sessionId) => invoke('getTokenStats', sessionId) as Promise<unknown>,
  invokePluginService: (name, ...rest) => invoke('invokePluginService', name, rest) as Promise<unknown>,
  modelCall: (input) => invoke('modelCall', input) as Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }>,
  listModels: () => invoke('listModels') as Promise<Array<{ id: string; name: string; modelType?: string }>>,
  modelCallStream: (input, handlers) => {
    const callId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const listener = (_e: unknown, payload: { callId?: string; type?: string; text?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; error?: string }) => {
      if (!payload || payload.callId !== callId) return
      if (payload.type === 'chunk') handlers.onChunk?.(payload.text ?? '')
      else if (payload.type === 'usage') handlers.onUsage?.(payload.usage as { promptTokens: number; completionTokens: number; totalTokens: number })
      else if (payload.type === 'done') { cleanup(); handlers.onDone?.() }
      else if (payload.type === 'error') { cleanup(); handlers.onError?.(new Error(payload.error ?? 'modelCallStream 失败')) }
    }
    const cleanup = () => ipcRenderer.removeListener('plugin:model-stream-event', listener)
    ipcRenderer.on('plugin:model-stream-event', listener)
    invoke('modelCallStream', { callId, ...input }).catch((err) => {
      cleanup()
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
    })
    return { cancel: cleanup }
  },
  videoGen: (input) => invoke('videoGen', input) as Promise<{ taskId: string }>,
  videoGenQuery: (input) => invoke('videoGenQuery', input) as Promise<{ status: string; progress?: number; videoUrl?: string; resultUrl?: string; videoUrlRaw?: string; errorMessage?: string }>,
  imageGen: (input) => invoke('imageGen', input) as Promise<{ taskId: string }>,
  imageGenQuery: (input) => invoke('imageGenQuery', input) as Promise<{ status: string; progress?: number; imageUrl?: string; resultUrl?: string; sourceUrl?: string; errorMessage?: string }>,
  tts: (input) => invoke('tts', input) as Promise<unknown>,
  netSubscribe: (channelId) => invoke('netSubscribe', channelId) as Promise<{ ok: boolean; channelId?: string; error?: string }>,
  netSend: (input) => invoke('netSend', input) as Promise<{ ok: boolean; channelId?: string; error?: string }>,
  // 与 modelCallStream 同一条「主进程推 → 窗口按标识过滤」的思路：
  // 主进程投递时只发「订阅了该通道的插件窗口」，帧上还带 pluginId；这里再比对一次本插件 id，
  // 双保险（windowAppId 由主进程注入 argv，插件改不了）。
  onNetFrame: (cb) => {
    const listener = (_e: unknown, frame: { pluginId?: string; channelId?: string; from?: string; payload?: unknown; ts?: number }) => {
      if (!frame || !frame.channelId) return
      if (windowAppId && frame.pluginId !== windowAppId) return
      cb({ pluginId: String(frame.pluginId ?? ''), channelId: frame.channelId, from: String(frame.from ?? ''), payload: frame.payload, ts: Number(frame.ts ?? 0) })
    }
    ipcRenderer.on('plugin:net-frame', listener)
    return () => ipcRenderer.removeListener('plugin:net-frame', listener)
  },
  uploadFile: (input) => invoke('uploadFile', input) as Promise<string>,
}

contextBridge.exposeInMainWorld('shanhaiPlugin', pluginBridge)
