/**
 * model-provider 模块：网关凭证 / 模型列表 / 登录登出 / 自定义模型 / 模型切换。
 *
 * 从 bootstrap 拆分：原来 resolveProvider / applyModel / applyGatewayModels /
 * refreshModelsViaApiKey / refreshGatewayModels / login / logout / listModels / refreshModels /
 * addCustomModel / updateCustomModel / removeCustomModel / getCurrentModelId 及启动时的凭证恢复
 * 都是 bootstrap 的闭包。现在收敛为 createModelProviderModule(ctx, deps)。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AuthSession, GatewayModel, ModelTier } from '@shanhai/auth'
import { TokenExpiredError } from '@shanhai/auth'
import type { Model } from '@shanhai/llm'
import { createModelProvider } from '@shanhai/llm'
import { createDeepSeekModel } from '@shanhai/deepseek-bridge'
import { createGatewayModel, inferTier, fetchGatewayModels } from './models'
import { persistLoginToken, persistCustomModels, persistSelectedModel, withConfigFile } from './config'
import type { RuntimeContext } from './context'
import type { CustomModelInput } from './types'
import type { TokenStatsModule } from './token-stats'
import type { DeepSeekBridgeModule } from './deepseek-bridge'

export interface ModelProviderModule {
  /** 解析（或缓存）指定模型的 provider，支持「会话管家异步转发」时多会话各自持有独立 provider */
  resolveProvider(modelId: string): Model
  /** 统一应用模型：更新当前模型 id + 切换 provider + 刷新上下文窗口长度 */
  applyModel(modelId: string): void
  /** 启动时恢复本地凭证（有 gateway apiKey 则视为已登录），并恢复选中模型 / 自定义模型 */
  restoreCredentials(): Promise<void>
  /** 应用一份新的网关模型列表（仅更新内存，不落盘），并通知前端 */
  applyGatewayModels(models: GatewayModel[]): Promise<void>
  /** token 失效时用长期有效的 apiKey 兜底刷新模型白名单 */
  refreshModelsViaApiKey(): Promise<GatewayModel[]>
  /** 用会员 token 重新拉取最新模型列表并应用；token 失效时用 apiKey 兜底 */
  refreshGatewayModels(): Promise<GatewayModel[]>
  /** 账号密码登录（SHA-256），成功后拉取会员模型并切换为真实网关模型 */
  login(u: string, p: string): Promise<{ username: string; nickname?: string }>
  /** 注册会员（手机号即账号，SHA-256），成功后等价于登录：拉模型 + 持久化凭证 */
  register(username: string, password: string, nickname?: string, phone?: string, email?: string): Promise<{ username: string; nickname?: string }>
  /** 退出登录：清空凭证，保留自定义模型与选中模型偏好 */
  logout(): Promise<void>
  /** 网关模型列表（系统内置 + 用户自定义） */
  listModels(): Promise<GatewayModel[]>
  /** 用会员 token 重新拉取最新模型列表 */
  refreshModels(): Promise<GatewayModel[]>
  /** 新增用户自定义模型 */
  addCustomModel(input: CustomModelInput): Promise<GatewayModel>
  /** 编辑用户自定义模型（按 id 更新） */
  updateCustomModel(id: string, input: CustomModelInput): Promise<GatewayModel>
  /** 删除用户自定义模型 */
  removeCustomModel(id: string): Promise<void>
  /** 当前选中的模型 id */
  getCurrentModelId(): string
  /** 解析统一压缩模型：配置了则返回其 provider，否则 undefined（AgentLoop 回退会话模型） */
  resolveCompactModel(): Model | undefined
}

/** 把网关/自定义模型的 temperature（string|number|undefined）安全转成 number；空串/非法值返回 undefined（不下发，用上游默认） */
function toTemperature(v: string | number | undefined): number | undefined {
  if (v == null) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return undefined
  return n
}

export function createModelProviderModule(
  ctx: RuntimeContext,
  deps: {
    allModels: () => GatewayModel[]
    tokenStats: TokenStatsModule
    deepSeekBridge: DeepSeekBridgeModule
    currentWorkDir: () => string
  },
): ModelProviderModule {
  const { allModels, tokenStats, deepSeekBridge, currentWorkDir } = deps

  const resolveProvider = (modelId: string): Model => {
    const cached = ctx.modelProviders.get(modelId)
    if (cached) return cached
    const target = allModels().find((m) => m.id === modelId)
    let provider = ctx.model
    if (target?.source === 'deepseek-bridge') {
      provider = createDeepSeekModel({ chat: deepSeekBridge.deepSeekChat, getWorkspace: currentWorkDir })
    } else if (target?.baseUrl) {
      provider = createModelProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, protocol: target.protocol, maxTokens: target.maxTokens, onUsage: tokenStats.onUsage, onTrace: tokenStats.onHttpTrace, supportsReasoning: target.supportsReasoning, temperature: toTemperature(target.temperature) })
    }
    ctx.modelProviders.set(modelId, provider)
    return provider
  }

  const applyModel = (modelId: string): void => {
    ctx.currentModelId = modelId
    ctx.model = resolveProvider(modelId)
    tokenStats.refreshContextLength()
  }

  const restoreCredentials = async (): Promise<void> => {
    try {
      const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
      const cfg = JSON.parse(raw) as {
        gateway?: {
          apiKey?: string
          baseUrl?: string
          memberToken?: string
          selectedModelId?: string
          account?: { username?: string; nickname?: string }
          models?: GatewayModel[]
          customModels?: GatewayModel[]
          approvalPolicy?: string
        }
        settings?: Record<string, unknown>
      }
      const g = cfg.gateway
      // memberToken 与 apiKey 解耦：JWT 是远程连接(relay)鉴权凭证，apiKey 是模型调用凭证，二者相互独立。
      ctx.memberToken = g?.memberToken ?? ''
      if (g?.apiKey) {
        ctx.loggedIn = true
        ctx.username = g.account?.nickname ?? g.account?.username ?? null
        ctx.gatewayApiKey = g.apiKey
        ctx.gatewayBaseUrl = g.baseUrl ?? ''
        // 网关内置模型列表不缓存到本地：内存 gatewayModels 保持空，登录态下由 refreshGatewayModels 实时从接口拉取
      }
      // 无论登录态，恢复用户上次选中的模型（登录后优先沿用）；同时作为全局默认模型
      if (g?.selectedModelId) {
        ctx.currentModelId = g.selectedModelId
        ctx.defaultModelId = g.selectedModelId
      }
      // 恢复用户自定义模型（标记 custom: true，登录态无关）
      if (Array.isArray(g?.customModels)) {
        ctx.customModels = g.customModels.map((m) => ({ ...m, custom: true }))
      }
    } catch {
      // 无凭证，未登录
    }
    // 启动后 ctx.model 仍是初始 mock provider（本函数只恢复 id、不切换 provider）。
    // 若选中模型当前可解析（如自定义模型已随 customModels 恢复），立即 applyModel 使 ctx.model 与选中模型一致；
    // 网关模型尚未 fetch（allModels 找不到），保持现状，交由登录后的 applyAuthSession 处理。
    if (ctx.currentModelId && allModels().some((m) => m.id === ctx.currentModelId)) {
      applyModel(ctx.currentModelId)
    }
  }

  const applyGatewayModels = async (models: GatewayModel[]): Promise<void> => {
    if (!Array.isArray(models) || models.length === 0) return
    ctx.gatewayModels = models
    ctx.modelsChangedCallbacks.forEach((cb) => cb())
    tokenStats.refreshContextLength()
  }

  const refreshModelsViaApiKey = async (): Promise<GatewayModel[]> => {
    if (!ctx.gatewayApiKey || !ctx.gatewayBaseUrl) return ctx.gatewayModels
    const upstream = await fetchGatewayModels(ctx.gatewayApiKey, ctx.gatewayBaseUrl)
    if (upstream.length === 0) return ctx.gatewayModels
    const enabledIds = new Set(upstream.map((m) => m.id))
    // 1) 剔除旧缓存里已被网关禁用/删除的模型
    const kept = ctx.gatewayModels.filter((m) => enabledIds.has(m.id))
    // 2) 补齐新增模型：统一用网关 apiKey + 统一入口 baseUrl（不能用上游地址）
    const keptIds = new Set(kept.map((m) => m.id))
    const added = upstream
      .filter((m) => !keptIds.has(m.id))
      .map((m) => ({ ...m, tier: inferTier(m.id), apiKey: ctx.gatewayApiKey, baseUrl: ctx.gatewayBaseUrl }))
    if (kept.length > 0 || added.length > 0) {
      await applyGatewayModels([...kept, ...added])
    }
    return ctx.gatewayModels
  }

  const refreshGatewayModels = async (): Promise<GatewayModel[]> => {
    // 无会员 token（老版本登录 / token 缺失）：用长期有效的 apiKey 兜底拉取「启用模型白名单」
    if (!ctx.memberToken) return refreshModelsViaApiKey()
    try {
      const models = await ctx.authService.fetchModels(ctx.memberToken)
      if (Array.isArray(models) && models.length > 0) {
        await applyGatewayModels(models.map((m) => ({ ...m, tier: inferTier(m.id) })))
      }
    } catch (err) {
      if (err instanceof TokenExpiredError || /invalid token|expired|unauthorized/i.test(String(err))) {
        await refreshModelsViaApiKey()
        if (ctx.gatewayModels.length === 0) {
          ctx.authExpiredCallbacks.forEach((cb) => cb())
        }
      }
    }
    return ctx.gatewayModels
  }

  /** 登录/注册共用的「会话落地」逻辑：设置登录态 + 拉模型 + 持久化凭证 */
  const applyAuthSession = async (s: AuthSession): Promise<{ username: string; nickname?: string }> => {
    ctx.loggedIn = true
    ctx.username = s.nickname ?? s.username
    ctx.memberToken = s.token
    const models = await ctx.authService.fetchModels(s.token)
    const first = models[0]
    if (first) {
      ctx.gatewayModels = models.map((m) => ({ ...m, tier: inferTier(m.id) }))
      ctx.gatewayApiKey = first.apiKey
      ctx.gatewayBaseUrl = first.baseUrl
      const cached = ctx.currentModelId
      const target =
        ctx.gatewayModels.find((m) => m.id === cached) ??
        ctx.gatewayModels.find((m) => m.id === 'deepseek-v4-flash') ??
        ctx.gatewayModels[0]
      if (target) {
        applyModel(target.id)
        ctx.defaultModelId = target.id
      }
    }
    tokenStats.refreshContextLength()
    await persistLoginToken(s.token, s.username, { nickname: s.nickname, avatar: s.avatar }, {
      apiKey: ctx.gatewayApiKey,
      baseUrl: ctx.gatewayBaseUrl,
      selectedModelId: ctx.currentModelId,
    })
    return { username: s.nickname ?? s.username, nickname: s.nickname }
  }

  const login = async (u: string, p: string): Promise<{ username: string; nickname?: string }> => {
    const s = await ctx.authService.login(u, p)
    return applyAuthSession(s)
  }

  const register = async (username: string, password: string, nickname?: string, phone?: string, email?: string): Promise<{ username: string; nickname?: string }> => {
    const s = await ctx.authService.register(username, password, nickname, phone, email)
    return applyAuthSession(s)
  }

  const logout = async (): Promise<void> => {
    ctx.loggedIn = false
    ctx.username = null
    ctx.gatewayApiKey = ''
    ctx.gatewayBaseUrl = ''
    ctx.memberToken = ''
    ctx.gatewayModels = []
    // 只清除登录凭证字段，保留用户自定义模型 + 选中模型偏好
    try {
      await withConfigFile((cfg) => {
        const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
        delete g.memberToken
        delete g.apiKey
        delete g.baseUrl
        delete g.account
        delete g.models
        cfg.gateway = g
      })
    } catch {
      // 忽略持久化失败
    }
    // 恢复模型：当前选中模型若仍可用（自定义模型或 DeepSeek 网页版，均不依赖登录），则继续用；否则回退 mock
    const target = allModels().find((m) => m.id === ctx.currentModelId)
    if (target?.source === 'deepseek-bridge') {
      ctx.model = createDeepSeekModel({ chat: deepSeekBridge.deepSeekChat, getWorkspace: currentWorkDir })
    } else if (target?.baseUrl) {
      ctx.model = createModelProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, protocol: target.protocol, maxTokens: target.maxTokens, onUsage: tokenStats.onUsage, onTrace: tokenStats.onHttpTrace, supportsReasoning: target.supportsReasoning, temperature: toTemperature(target.temperature) })
    } else {
      ctx.model = await createGatewayModel(tokenStats.onUsage, tokenStats.onHttpTrace)
    }
    ctx.defaultModelId = ''
    tokenStats.refreshContextLength()
  }

  const listModels = async (): Promise<GatewayModel[]> => allModels()

  const refreshModels = async (): Promise<GatewayModel[]> => refreshGatewayModels()

  const addCustomModel = async (input: CustomModelInput): Promise<GatewayModel> => {
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const custom: GatewayModel = {
      id,
      name: input.name || input.model,
      model: input.model,
      tier: 'flagship',
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      contextLength: input.contextLength,
      supportsVision: input.supportsVision,
      custom: true,
    }
    ctx.customModels = [...ctx.customModels, custom]
    await persistCustomModels(ctx.customModels)
    // 通知前端刷新模型列表（否则主进程 ui-store 不重拉，跨窗口/下拉框看不到新模型，需重启才生效）
    ctx.modelsChangedCallbacks.forEach((cb) => cb())
    return custom
  }

  const updateCustomModel = async (id: string, input: CustomModelInput): Promise<GatewayModel> => {
    const existing = ctx.customModels.find((m) => m.id === id)
    if (!existing) throw new Error(`自定义模型不存在: ${id}`)
    const updated: GatewayModel = {
      id: existing.id,
      name: input.name || input.model,
      model: input.model,
      tier: existing.tier,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      contextLength: input.contextLength ?? existing.contextLength,
      maxTokens: existing.maxTokens,
      temperature: existing.temperature,
      supportsVision: input.supportsVision ?? existing.supportsVision,
      supportsReasoning: existing.supportsReasoning,
      provider: existing.provider,
      sortOrder: existing.sortOrder,
      description: existing.description,
      source: existing.source,
      custom: true,
    }
    ctx.customModels = ctx.customModels.map((m) => (m.id === id ? updated : m))
    // 清除旧 provider 缓存，避免 resolveProvider 命中旧配置（编辑后仍用旧 apiKey/baseUrl/model）
    ctx.modelProviders.delete(id)
    // 若正在使用该模型，重新解析 provider（resolveProvider 会重建并缓存新配置）
    if (ctx.currentModelId === id) {
      applyModel(id)
    }
    await persistCustomModels(ctx.customModels)
    ctx.modelsChangedCallbacks.forEach((cb) => cb())
    return updated
  }

  const removeCustomModel = async (id: string): Promise<void> => {
    ctx.customModels = ctx.customModels.filter((m) => m.id !== id)
    ctx.modelProviders.delete(id)
    if (ctx.currentModelId === id) {
      ctx.currentModelId = ''
      ctx.model = await createGatewayModel(tokenStats.onUsage, tokenStats.onHttpTrace)
    }
    // 删除的是全局默认模型时，回退到剩余模型第一个（否则重启后 restoreCredentials 会恢复已删除的 id）
    if (ctx.defaultModelId === id) {
      ctx.defaultModelId = ctx.customModels[0]?.id ?? ctx.gatewayModels[0]?.id ?? ''
      void persistSelectedModel(ctx.defaultModelId)
    }
    tokenStats.refreshContextLength()
    await persistCustomModels(ctx.customModels)
    ctx.modelsChangedCallbacks.forEach((cb) => cb())
  }

  const getCurrentModelId = (): string => ctx.currentModelId

  const resolveCompactModel = (): Model | undefined => {
    const id = ctx.currentSettings.compaction?.modelId
    if (!id) return undefined
    return resolveProvider(id)
  }

  return {
    resolveProvider,
    applyModel,
    restoreCredentials,
    applyGatewayModels,
    refreshModelsViaApiKey,
    refreshGatewayModels,
    login,
    register,
    logout,
    listModels,
    refreshModels,
    addCustomModel,
    updateCustomModel,
    removeCustomModel,
    getCurrentModelId,
    resolveCompactModel,
  }
}
