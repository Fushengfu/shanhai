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
   * 模型调用（受控单次文本生成）：用「当前选中的模型」生成一次文本。
   * 需显式声明 permissions: ["modelCall"]；不能指定模型 id、不能切模型，单次 maxTokens 上限由主进程固定。
   * 入参 { prompt: 必填用户提示词, systemPrompt?: 可选系统提示词 }，返回 { text, usage? }。
   */
  modelCall(input: { prompt: string; systemPrompt?: string }): Promise<{ text: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }>
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
}

contextBridge.exposeInMainWorld('shanhaiPlugin', pluginBridge)
