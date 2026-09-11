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
import { persistLoginToken, persistCustomModels, persistSelectedModel, withConfigFile, persistMemberTokenRotation } from './config'
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
  login(u: string, p: string): Promise<{ username: string; nickname?: string; avatar?: string }>
  /** 注册会员（手机号即账号，SHA-256），成功后等价于登录：拉模型 + 持久化凭证 */
  register(username: string, password: string, nickname?: string, phone?: string, email?: string): Promise<{ username: string; nickname?: string; avatar?: string }>
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
  /**
   * 应用续签得到的新会员 JWT：更新内存 ctx + 落盘（只动 memberToken 与有效期字段）。
   * 供主进程续签模块（apps/desktop member-credentials.ts）在 refresh 成功后调用，
   * 使所有 getMemberToken() 使用方（relay / member-channel / 上传 / 模型列表）立刻读到新值。
   */
  applyMemberToken(token: string, expiresAt: number | null, ttlSeconds: number | null): Promise<void>
  /** 会员 JWT 有效期（null = 未知，不得据此判过期） */
  getMemberTokenExpiry(): { expiresAt: number | null; ttlSeconds: number | null }
}

/** 把网关/自定义模型的 temperature（string|number|undefined）安全转成 number；空串/非法值返回 undefined（不下发，用上游默认） */
function toTemperature(v: string | number | undefined): number | undefined {
  if (v == null) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return undefined
  return n
}

/** 用户自定义模型的缺省采样温度：用户没有显式配置过时用 0（采样最确定，弱模型最不易跑偏） */
const CUSTOM_MODEL_DEFAULT_TEMPERATURE = 0

/**
 * 解析要下发给上游的 temperature（单一真相源，resolveProvider 与 logout 后的模型恢复分支两处共用，避免两处口径漂移）：
 * - 用户自定义模型（custom === true）：用户在模型配置里显式配过合法数值就尊重他的值，没配过才缺省 0；
 * - 系统内置网关模型（custom 不为 true）：一律不下发（undefined），由网关按它自己的模型配置决定，
 *   山海侧不注入也不覆盖。
 * 判据用 custom 字段（山海侧唯一的自定义标记：新增/编辑/恢复自定义模型时写入 true，网关下发的模型不带该字段），
 * 不用模型名前缀这类脆弱判据。
 * 注：思考模式（reasoningEffort / thinking）下 provider 层本就不下发采样参数，该分支不受此处返回值影响。
 */
function resolveTemperature(target: GatewayModel): number | undefined {
  if (target.custom !== true) return undefined
  return toTemperature(target.temperature) ?? CUSTOM_MODEL_DEFAULT_TEMPERATURE
}

/**
 * 从会员 JWT 的 payload 里解出有效期（exp / iat，单位秒 → 毫秒）。
 * 只读本地已有 token 的 payload，不校验签名、不外发；解不出返回 { expiresAt: null, ttlSeconds: null }。
 * 为什么需要它：@shanhai/auth 的 AuthSession 目前不透传网关登录响应的 expires_at/expires_in（本轮不允许改 packages/*），
 * 而 JWT 的 exp 声明本身就是网关签发的权威有效期，二者等价（网关侧已核对 exp = iat + member_expire_hour）。
 * 老 config（无 memberTokenExpiresAt 字段）也靠它降级拿到过期时间，避免「缺字段就判未知」。
 */
function jwtExpiryOf(token: string): { expiresAt: number | null; ttlSeconds: number | null } {
  const payload = typeof token === 'string' ? token.split('.')[1] : undefined
  if (!payload) return { expiresAt: null, ttlSeconds: null }
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
    const exp = typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp : null
    const iat = typeof json.iat === 'number' && Number.isFinite(json.iat) ? json.iat : null
    return {
      expiresAt: exp !== null ? exp * 1000 : null,
      ttlSeconds: exp !== null && iat !== null && exp > iat ? exp - iat : null,
    }
  } catch {
    return { expiresAt: null, ttlSeconds: null }
  }
}

/** 把网关/自定义模型的 reasoningEffort（string|undefined）安全归一；空串/非法返回 undefined（不下发，用模型默认）。档位规范化（medium/xhigh→high 等）在 provider 层按协议处理 */
function toReasoningEffort(v: string | undefined): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  return s
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

  /**
   * 【任务248 · 修复模型解析缓存污染】
   * 旧行为：按 modelId 查不到模型记录时，把「当前全局 provider」（ctx.model）当作该模型的 provider
   * 返回，并在末尾无条件 ctx.modelProviders.set(modelId, provider) 写进缓存。
   * 而网关模型列表是启动后 fire-and-forget 异步拉取的（bootstrap.ts:952 `void refreshGatewayModels()`
   * 不 await；model-provider.ts 内注释亦明写「网关内置模型列表不缓存到本地」），于是重启后头几秒内
   * 任何一次模型解析都会把该 modelId 永久绑成全局默认模型的 provider，且整个进程生命周期不自愈。
   * 子会话与管家共用同一份 ctx.modelProviders（execution.ts:102 / :435 两条路径最终都进这里），
   * 表现为「界面显示 deepseek-v4-flash、实际请求发出 qwen3.8-flash」两侧同时命中。
   * 新行为：**只有命中模型记录时才写缓存**；未命中不 set（缓存永不被污染），等列表到位后
   * 由 applyGatewayModels 的自愈逻辑重新解析（见下方【任务248】注释）。
   * ⚠️ 未命中时「返回什么 provider」在【任务249】里又改了一次：网关列表尚未到手时改为用网关凭证
   * 现造一次性 provider（使出口 model 恒等于会话 meta.modelId），详见函数体内【任务249】注释。
   */
  const resolveProvider = (modelId: string): Model => {
    const cached = ctx.modelProviders.get(modelId)
    if (cached) return cached
    const target = allModels().find((m) => m.id === modelId)
    // 未命中：不缓存、不绑定（否则一次竞态就永久错）。命中路径的下方逻辑与改前逐字一致。
    if (!target) {
      // 【任务249 · 闭合 248 残留的「时序①」】未命中记录时不再一律回落全局 provider。
      // 场景：Cmd+Q 重启后网关模型列表还在异步拉取（bootstrap.ts:952 `void refreshGatewayModels()` 不 await），
      // 用户第一件事就是发消息 → 此刻 allModels() 里没有该 modelId 的记录，248 之后虽然「不永久污染 + 到位即自愈」，
      // 但**那第一条消息**仍会发出全局默认模型（界面显示的却是会话 meta 里的模型）——从用户视角等于没修完。
      // 新行为：仅当「权威的网关模型列表还没拿到手」（ctx.gatewayModels 为空 = 正是那个竞态窗口）时，
      // 用主进程已持有的网关凭证现造一个**一次性** provider，model 直接取 modelId
      // （无记录可查，也就没有 target.model 上游别名可言），于是出口 model 恒等于 meta.modelId。
      // 先例：models.ts:18 `createGatewayModel` 同样是纯凭 apiKey + baseUrl + modelId 构造、完全不依赖模型列表。
      // 四条硬约束（详见任务249）：
      //  ① 只对「网关来源」生效，判据有两层且都必须成立：
      //     (a) 列表尚未到手（ctx.gatewayModels.length === 0）—— 列表已到手却查不到 = 该 id 根本不是网关模型
      //         （被删的自定义模型 / 拼错的 id / 未注册的桥模型），此时**绝不**凭空造一个网关 provider，
      //         保持 248 的回落语义，避免把未知 id 连同网关凭证发给网关；
      //     (b) 该 id 不是当前已登记的自定义模型、也不是 DeepSeek 网页版桥模型 —— 它们各有自己的构造路径与端点，
      //         绝不能拿网关 apiKey 去请求非网关端点（凭证错配 = 安全问题）。
      //  ② **不写缓存**：用完即弃，保持 248 的「miss 不落缓存」语义；列表到位后由 applyGatewayModels
      //     清表 + 按权威记录（含 protocol / maxTokens / 上游别名）重建，本兜底只是过渡态。
      //  ③ 未登录 / 无网关凭证：如实返回改前行为（回落 ctx.model），不抛错、不把消息卡死。
      //  ④ baseUrl 一律取 ctx.gatewayBaseUrl（网关统一入口），本兜底不存在把请求发往第三方端点的可能。
      const listNotInHandYet = ctx.gatewayModels.length === 0
      const hasOwnConstructionPath = ctx.customModels.some((m) => m.id === modelId) || ctx.deepseekBridgeModel?.id === modelId
      if (listNotInHandYet && !hasOwnConstructionPath && ctx.loggedIn && ctx.gatewayApiKey && ctx.gatewayBaseUrl) {
        return createModelProvider({ apiKey: ctx.gatewayApiKey, baseUrl: ctx.gatewayBaseUrl, model: modelId, onUsage: tokenStats.onUsage, onTrace: tokenStats.onHttpTrace })
      }
      return ctx.model
    }
    let provider = ctx.model
    if (target.source === 'deepseek-bridge') {
      provider = createDeepSeekModel({ chat: deepSeekBridge.deepSeekChat, getWorkspace: currentWorkDir })
    } else if (target?.baseUrl) {
      provider = createModelProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, protocol: target.protocol, maxTokens: target.maxTokens, onUsage: tokenStats.onUsage, onTrace: tokenStats.onHttpTrace, supportsReasoning: target.supportsReasoning, temperature: resolveTemperature(target), reasoningEffort: toReasoningEffort(target.reasoningEffort) })
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
          account?: { username?: string; nickname?: string; avatar?: string }
          models?: GatewayModel[]
          customModels?: GatewayModel[]
          approvalPolicy?: string
          memberTokenExpiresAt?: number
          memberTokenTtlSeconds?: number
        }
        settings?: Record<string, unknown>
      }
      const g = cfg.gateway
      // memberToken 与 apiKey 解耦：JWT 是远程连接(relay)鉴权凭证，apiKey 是模型调用凭证，二者相互独立。
      ctx.memberToken = g?.memberToken ?? ''
      // 会员 JWT 有效期：优先读落盘值（登录 / 续签时写入），老 config 无该字段则从 JWT exp 降级解出，
      // 两者都拿不到才记为「未知」（null）。⚠️ 未知 ≠ 已过期：不得因缺字段就判过期或拒绝续签（见 member-credentials.ts）。
      const persistedExpiresAt = typeof g?.memberTokenExpiresAt === 'number' && Number.isFinite(g.memberTokenExpiresAt) ? g.memberTokenExpiresAt : null
      const persistedTtl = typeof g?.memberTokenTtlSeconds === 'number' && Number.isFinite(g.memberTokenTtlSeconds) ? g.memberTokenTtlSeconds : null
      const derived = ctx.memberToken ? jwtExpiryOf(ctx.memberToken) : { expiresAt: null, ttlSeconds: null }
      ctx.memberTokenExpiresAt = persistedExpiresAt ?? derived.expiresAt
      ctx.memberTokenTtlSeconds = persistedTtl ?? derived.ttlSeconds
      if (g?.apiKey) {
        ctx.loggedIn = true
        ctx.username = g.account?.nickname ?? g.account?.username ?? null
        // 【任务235】登录态下恢复「自己的」头像 URL（老 config 无该字段 → null，渲染层回落首字）。
        ctx.avatar = g.account?.avatar ?? null
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
    // 【任务248 · 配套兜底：让已经发生的缓存污染能自愈，不必等用户重启】
    // 模型列表刷新成功 = 此刻才第一次拥有「权威且完整」的模型记录，之前按 modelId 缓存下来的
    // provider 全都不可信（可能是列表未到位时留下的污染条目，也可能是用旧 apiKey/baseUrl 建的条目），
    // 因此整表清空，再按当前选中模型重新解析登记（resolveProvider 命中记录后会重新缓存）。
    // 清空对自定义模型同样安全：resolveProvider 会从 ctx.customModels 原样重建同一配置的 provider。
    // 注意这里只重建 provider 缓存，不动 ctx.currentModelId / ctx.defaultModelId / 会话 meta，
    // 也不新增任何状态字段或开关。
    ctx.modelProviders.clear()
    if (ctx.currentModelId && allModels().some((m) => m.id === ctx.currentModelId)) {
      applyModel(ctx.currentModelId)
    }
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
  const applyAuthSession = async (s: AuthSession): Promise<{ username: string; nickname?: string; avatar?: string }> => {
    ctx.loggedIn = true
    ctx.username = s.nickname ?? s.username
    // 【任务235】只读暴露「自己的」头像 URL（AuthSession 由 packages/auth 产出，这里仅转存到内存；
    // 不做任何判定改动、不涉及 memberId）。
    ctx.avatar = s.avatar ?? null
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
    // 会员 JWT 有效期：登录/注册响应即落盘（网关未透传 expires_at 时从 JWT exp 降级解出，见 jwtExpiryOf）
    const expiry = jwtExpiryOf(s.token)
    ctx.memberTokenExpiresAt = expiry.expiresAt
    ctx.memberTokenTtlSeconds = expiry.ttlSeconds
    await persistLoginToken(s.token, s.username, { nickname: s.nickname, avatar: s.avatar }, {
      apiKey: ctx.gatewayApiKey,
      baseUrl: ctx.gatewayBaseUrl,
      selectedModelId: ctx.currentModelId,
    }, expiry)
    return { username: s.nickname ?? s.username, nickname: s.nickname, avatar: s.avatar }
  }

  const login = async (u: string, p: string): Promise<{ username: string; nickname?: string; avatar?: string }> => {
    const s = await ctx.authService.login(u, p)
    return applyAuthSession(s)
  }

  const register = async (username: string, password: string, nickname?: string, phone?: string, email?: string): Promise<{ username: string; nickname?: string; avatar?: string }> => {
    const s = await ctx.authService.register(username, password, nickname, phone, email)
    return applyAuthSession(s)
  }

  const logout = async (): Promise<void> => {
    ctx.loggedIn = false
    ctx.username = null
    ctx.avatar = null
    ctx.gatewayApiKey = ''
    ctx.gatewayBaseUrl = ''
    ctx.memberToken = ''
    ctx.memberTokenExpiresAt = null
    ctx.memberTokenTtlSeconds = null
    ctx.gatewayModels = []
    // 只清除登录凭证字段，保留用户自定义模型 + 选中模型偏好
    try {
      await withConfigFile((cfg) => {
        const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
        delete g.memberToken
        delete g.memberTokenExpiresAt
        delete g.memberTokenTtlSeconds
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
      ctx.model = createModelProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, protocol: target.protocol, maxTokens: target.maxTokens, onUsage: tokenStats.onUsage, onTrace: tokenStats.onHttpTrace, supportsReasoning: target.supportsReasoning, temperature: resolveTemperature(target), reasoningEffort: toReasoningEffort(target.reasoningEffort) })
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

  const applyMemberToken = async (token: string, expiresAt: number | null, ttlSeconds: number | null): Promise<void> => {
    const clean = typeof token === 'string' ? token.trim() : ''
    if (!clean) throw new Error('applyMemberToken: 新 token 为空')
    ctx.memberToken = clean
    // 网关未回传过期时间时从新 JWT 的 exp 降级解出（与登录路径同一口径）
    const derived = jwtExpiryOf(clean)
    ctx.memberTokenExpiresAt = typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : derived.expiresAt
    ctx.memberTokenTtlSeconds = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) ? ttlSeconds : derived.ttlSeconds
    await persistMemberTokenRotation(clean, { expiresAt: ctx.memberTokenExpiresAt, ttlSeconds: ctx.memberTokenTtlSeconds })
  }

  const getMemberTokenExpiry = (): { expiresAt: number | null; ttlSeconds: number | null } => ({
    expiresAt: ctx.memberTokenExpiresAt,
    ttlSeconds: ctx.memberTokenTtlSeconds,
  })

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
    applyMemberToken,
    getMemberTokenExpiry,
  }
}
