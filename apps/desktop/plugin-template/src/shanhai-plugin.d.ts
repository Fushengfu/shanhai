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
}

declare global {
  interface Window {
    shanhaiPlugin?: ShanhaiPluginBridge
  }
}

export {}
