/**
 * DeepSeek 网页版桥接模块（CDP 直连，非工具/技能）：模型来源注册 + 复用当前会话默认窗口。
 *
 * 从 bootstrap 拆分：原来 registerDeepSeekBridgeModel / ensureDeepSeekBridgeWindow /
 * deepSeekChat / ensureDefaultBrowserWindow 及 getDeepSeekBridgeStatus / openDeepSeekBridge /
 * injectDeepSeekBridge 都是 bootstrap 的闭包。现在收敛为 createDeepSeekBridgeModule(ctx, getCurrentSid)。
 */
import type { RuntimeContext } from './context'
import { buildBridgeScript, BRIDGE_READY_CHECK } from '@shanhai/deepseek-bridge'

export interface DeepSeekBridgeModule {
  /** 每会话默认创建一个浏览器窗口（受「网页版桥接」开关控制，预创建不显示） */
  ensureDefaultBrowserWindow(sid: string): void
  /** 注册「DeepSeek 网页版」模型来源（幂等） */
  registerDeepSeekBridgeModel(): void
  /** 确保「当前会话默认窗口」存在、位于 chat.deepseek.com 且已注入桥接脚本 */
  ensureDeepSeekBridgeWindow(): Promise<void>
  /** 与 DeepSeek 网页版对话：复用当前会话默认窗口（共享登录态）+ 注入脚本 + CDP 直连 */
  deepSeekChat(prompt: string, opts: { mode: string; thinking: boolean }): Promise<string>
  /** DeepSeek 网页版桥接状态（专用浏览器窗口是否已创建 / 桥接脚本是否已注入） */
  getStatus(): Promise<{ windowReady: boolean; bridgeInjected: boolean }>
  /** 打开 DeepSeek 页面并注入桥接脚本 */
  open(): Promise<{ ok: boolean; message: string }>
  /** 仅注入桥接脚本（DeepSeek 页面已打开时用） */
  inject(): Promise<{ ok: boolean; message: string }>
}

export function createDeepSeekBridgeModule(ctx: RuntimeContext, getCurrentSid: () => string): DeepSeekBridgeModule {
  const ensureDefaultBrowserWindow = (sid: string): void => {
    if (!sid) return
    if (!ctx.currentSettings.browser.enableWebBridge) return
    // 预创建窗口不显示（后台预加载，避免每次切换会话都弹出一个浏览器窗口干扰用户）；agent 真正操作时才 show
    ctx.browserUse.setShowOnCreate?.(false)
    void ctx.browserUse
      .create(sid, 'https://chat.deepseek.com')
      .catch(() => {
        // 预创建失败忽略：首次 browser 操作仍会懒创建窗口兜底
      })
      .finally(() => {
        ctx.browserUse.setShowOnCreate?.(true)
      })
  }

  const registerDeepSeekBridgeModel = (): void => {
    if (ctx.deepseekBridgeModel) return
    ctx.deepseekBridgeModel = {
      id: 'deepseek-web',
      name: 'DeepSeek 网页版',
      displayName: 'DeepSeek 网页版',
      model: 'deepseek-chat',
      tier: 'flagship',
      apiKey: '',
      baseUrl: '',
      protocol: 'openai',
      provider: 'deepseek-bridge',
      source: 'deepseek-bridge',
      custom: false,
    }
  }

  const ensureDeepSeekBridgeWindow = async (): Promise<void> => {
    const sid = getCurrentSid()
    if (!sid) throw new Error('当前无活动会话')
    const wins = await ctx.browserUse.list()
    const win = wins.find((w) => w.appId === sid)
    if (!win) {
      // 窗口不存在 → 创建并打开 DeepSeek 网页版（会话级默认窗口走共享 partition，登录一次全通用）
      await ctx.browserUse.navigate('https://chat.deepseek.com', sid)
    } else if (!/chat\.deepseek\.com/.test(win.url || '')) {
      // 窗口存在但不在 DeepSeek 页面 → 导航过去（避免在别的页面里找不到输入框）
      await ctx.browserUse.navigate('https://chat.deepseek.com', sid)
    }
    // 注入桥接脚本（幂等：已注入则跳过）
    const ready = await ctx.browserUse.evaluate(BRIDGE_READY_CHECK, sid).catch(() => false)
    if (!ready) {
      await ctx.browserUse.evaluate(buildBridgeScript(), sid)
    }
  }

  const deepSeekChat = async (prompt: string, opts: { mode: string; thinking: boolean }): Promise<string> => {
    await ensureDeepSeekBridgeWindow()
    const sid = getCurrentSid()
    if (!ctx.browserUse.chatWithPageBridge) throw new Error('当前后端不支持页面桥接（chatWithPageBridge 未实现）')
    try {
      return await ctx.browserUse.chatWithPageBridge(prompt, { mode: opts.mode, thinking: opts.thinking }, sid)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 未登录 / 页面未加载完成时页面里没有输入框，给可操作的引导，而非生硬的内部报错
      if (/no textarea|no send button/i.test(msg)) {
        throw new Error('DeepSeek 网页版尚未就绪：请在本会话弹出的浏览器窗口里登录 chat.deepseek.com 后再试（登录态跨会话通用，只需登录一次）')
      }
      throw err
    }
  }

  const getStatus = async (): Promise<{ windowReady: boolean; bridgeInjected: boolean }> => {
    try {
      const sid = ctx.currentSessionId ?? ''
      if (!sid) return { windowReady: false, bridgeInjected: false }
      const wins = await ctx.browserUse.list()
      const windowReady = wins.some((w) => w.appId === sid)
      let bridgeInjected = false
      if (windowReady) {
        bridgeInjected = Boolean(await ctx.browserUse.evaluate(BRIDGE_READY_CHECK, sid).catch(() => false))
      }
      return { windowReady, bridgeInjected }
    } catch {
      return { windowReady: false, bridgeInjected: false }
    }
  }

  const open = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      await ensureDeepSeekBridgeWindow()
      return { ok: true, message: '已打开当前会话的 DeepSeek 页面并注入桥接脚本，请在该窗口登录 chat.deepseek.com（登录态跨会话通用）' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  const inject = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      await ensureDeepSeekBridgeWindow()
      return { ok: true, message: '桥接脚本已注入当前会话的 DeepSeek 页面，请保持页面打开' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  return { ensureDefaultBrowserWindow, registerDeepSeekBridgeModel, ensureDeepSeekBridgeWindow, deepSeekChat, getStatus, open, inject }
}
