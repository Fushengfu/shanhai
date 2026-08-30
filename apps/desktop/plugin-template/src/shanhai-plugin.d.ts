/**
 * 插件专用 preload（plugin.cjs）暴露的白名单桥类型声明。
 *
 * 与 apps/desktop/src/preload/plugin.ts 的 ShanhaiPluginBridge 一一对应：
 * 插件窗口（独立渲染进程）里 window.shanhaiPlugin 可调用的公开能力，每个方法
 * 统一走主进程 plugin:invoke 入口，按「插件 id + 能力名」双层校验（能力在全局
 * 白名单 + 插件 manifest.permissions 声明了它），否则抛错拒绝。
 */
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
  /** 精简 UI 状态（只含登录态 + 用户名 + 壁纸，隔离敏感数据） */
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
  /** 列出可用模型（精简 id + 展示名，隔离 apiKey/baseUrl 等敏感字段）。需显式声明 permissions: ["listModels"] */
  listModels(): Promise<Array<{ id: string; name: string }>>
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
}

declare global {
  interface Window {
    shanhaiPlugin?: ShanhaiPluginBridge
    /** 宿主桥（窗口控制 + 只读信息，按 sender 反查自身窗口，无法越权） */
    shanhai?: ShanhaiHostBridge
  }
}

/** 插件窗口宿主桥（window.shanhai）：窗口控制 + 只读信息，主进程按 sender 反查自身窗口 */
export interface ShanhaiHostBridge {
  windowType: string
  platform: string
  windowAppId?: string
  getPluginApp(appId: string): Promise<unknown>
  closeApp(appId: string): Promise<void>
  minimizeWindow(): void
  toggleMaximizeWindow(): Promise<boolean>
  /** 订阅主题变更（主进程 ui:theme 广播给所有窗口），返回取消订阅函数。插件窗口据此跟随内置应用亮/暗切换 */
  onThemeChange(cb: (theme: 'light' | 'dark') => void): () => void
}

export {}
