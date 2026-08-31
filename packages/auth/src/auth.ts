import { createHash } from 'node:crypto'

/** 模型路由三层 */
export type ModelTier = 'flagship' | 'value' | 'vision'

export interface GatewayModel {
  id: string
  name: string
  /** 展示名（网关 displayName，无则回退 name/id） */
  displayName?: string
  /** 网关实际请求的 model 参数（无则用 id） */
  model?: string
  tier: ModelTier
  apiKey: string
  baseUrl: string
  contextLength?: number
  maxTokens?: number
  temperature?: string
  supportsVision?: boolean
  supportsReasoning?: boolean
  /**
   * 推理档位能力/默认档位（reasoning_effort）：模型支持的可选档位或默认档位（如 low/high/max），
   * 网关从上游下发或按模型能力标记。设置后，支持思考的模型会在请求 body 带 reasoning_effort（DeepSeek/OpenAI 兼容）
   * 或 reasoning.effort（Anthropic），并进入「思考模式」（思考模式下屏蔽 temperature 等采样参数）。未设置则不启用思考强度控制。
   */
  reasoningEffort?: string
  /**
   * 支持的 reasoning_effort 档位枚举（如 ['low','high','max']）。
   * 网关模型列表不下发时，山海侧用内置表按模型名补（见 resolveBuiltinReasoningEffort）。
   * 供模型设置 UI 选档；默认档位见 reasoningEffort。
   */
  reasoningEfforts?: string[]
  /** 模型真实提供商（deepseek/alibaba/ollama/mimo/moonshot/minimax/custom） */
  provider?: string
  /**
   * 调用协议：openai=OpenAI 兼容 /chat/completions（默认），anthropic=Anthropic 原生 /messages。
   * 用户自定义模型由用户在 UI 上选择；系统网关模型缺省视为 openai（网关若明确标记 anthropic 则映射）。
   */
  protocol?: 'openai' | 'anthropic'
  /** 列表排序权重（网关 sortOrder） */
  sortOrder?: number
  description?: string
  source?: string
  /** 模型类型：chat=对话（缺省） / video=视频生成 / image=图片生成 / tts=语音合成。网关下发后透传，用于界面/插件按类型分组 */
  modelType?: string
  /** 是否为用户自定义模型（true 自定义 / false 或 undefined 系统内置） */
  custom?: boolean
}

export interface BuiltinReasoningEffort {
  efforts: string[]
  defaultEffort: string
}

/**
 * 内置「模型族 → reasoning_effort 档位枚举」表（山海侧自维护）。
 * 当网关模型列表接口（/api/v1/models、/api/member/models）不下发 reasoningEffort 时，按模型名匹配补默认档位 + 档位枚举。
 * 未匹配到内置表的模型不注入（保持网关原样）。
 */
const BUILTIN_REASONING_EFFORT_MAP: Array<{ pattern: RegExp; efforts: string[]; defaultEffort: string }> = [
  // DeepSeek 推理系（v4 flash/pro 等）→ ['low','high','max']，默认最高档 max
  { pattern: /deepseek-v4|deepseek-reasoner/i, efforts: ['low', 'high', 'max'], defaultEffort: 'max' },
  // OpenAI 推理系 o1/o3/o4 系列 → ['low','medium','high']，默认最高档 high
  { pattern: /(^|[^a-z0-9])o[134]([^a-z0-9]|$)/i, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  // Anthropic（thinking 机制）→ ['low','high','max']，默认最高档 high
  { pattern: /anthropic|claude/i, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
]

/** 按模型名/id 匹配内置推理档位；未匹配返回 undefined（不注入，保持网关原样） */
export function resolveBuiltinReasoningEffort(idOrModel: string): BuiltinReasoningEffort | undefined {
  const lower = String(idOrModel ?? '').toLowerCase()
  for (const row of BUILTIN_REASONING_EFFORT_MAP) {
    if (row.pattern.test(lower)) return { efforts: row.efforts, defaultEffort: row.defaultEffort }
  }
  return undefined
}

export interface AuthSession {
  token: string
  username: string
  nickname?: string
  avatar?: string
  balance?: number
}

/** 网关登录/注册响应（兼容多种 token 字段命名） */
interface RawAuthResponse {
  code?: number
  message?: string
  token?: string
  memberToken?: string
  access_token?: string
  data?: {
    token?: string
    memberToken?: string
    access_token?: string
    member?: { nickname?: string; avatar?: string; balance?: number }
  }
}

export interface AuthServiceOptions {
  /** 网关基地址（会员体系），如 https://agent.bjctykj.com */
  baseUrl: string
}

/** token 失效（过期/无效）。用于让调用方感知并走「重新登录」或「apiKey 兜底刷新」，而非静默吞掉。 */
export class TokenExpiredError extends Error {
  constructor(message = 'token expired') {
    super(message)
    this.name = 'TokenExpiredError'
  }
}

/**
 * 认证服务：账号密码登录 → JWT → 拉模型。
 *
 * 登录规则（硬约束）：
 * - 登录方式只有「账号密码登录」一种，不提供「自定义 API Key」作为登录方式。
 * - 密码必须 SHA-256 加密后以小写 hex 提交（明文会被网关拒）。
 */
export class AuthService {
  constructor(private readonly opts: AuthServiceOptions) {}

  /** 密码 SHA-256 小写 hex（只在登录请求瞬间使用，不落盘） */
  static sha256Hex(password: string): string {
    return createHash('sha256').update(password).digest('hex')
  }

  async login(username: string, password: string): Promise<AuthSession> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/api/member/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: AuthService.sha256Hex(password) }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`login failed ${res.status}: ${body}`)
    }
    // 网关响应：{ code, data: { token|memberToken|access_token, member }, message }（兼容多种字段）
    return this.parseSessionResponse((await res.json()) as RawAuthResponse, username, 'login')
  }

  /**
   * 注册会员：手机号即账号（username），密码 SHA-256 加密后提交。
   * 参考网关 /api/member/register，body { username, password, nickname?, phone?, email? }。
   */
  async register(username: string, password: string, nickname?: string, phone?: string, email?: string): Promise<AuthSession> {
    const body: Record<string, string> = {
      username,
      password: AuthService.sha256Hex(password),
    }
    if (nickname) body.nickname = nickname
    if (phone) body.phone = phone
    if (email) body.email = email
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/api/member/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`register failed ${res.status}: ${text}`)
    }
    return this.parseSessionResponse((await res.json()) as RawAuthResponse, username, 'register')
  }

  /** 解析登录/注册响应为 AuthSession（兼容 code/data/token 多种字段） */
  private parseSessionResponse(raw: RawAuthResponse, username: string, op: string): AuthSession {
    if (raw.code !== undefined && raw.code !== 0) {
      throw new Error(raw.message ?? `${op} failed code=${raw.code}`)
    }
    const token = raw.data?.token ?? raw.token ?? raw.data?.memberToken ?? raw.memberToken ?? raw.data?.access_token ?? raw.access_token
    if (!token) {
      throw new Error(`${op} response missing token: ${JSON.stringify(raw).slice(0, 300)}`)
    }
    const member = raw.data?.member
    return {
      token,
      username,
      nickname: member?.nickname,
      avatar: member?.avatar,
      balance: member?.balance,
    }
  }

  async logout(): Promise<void> {
    // 无状态 JWT，客户端只需清除本地凭证（由 CredentialStore.clear 处理）
  }

  async fetchModels(token: string): Promise<GatewayModel[]> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/api/member/models`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.text()
      // token 失效（网关返回 401 + {"error":"invalid token"}）要能被上层识别，走重新登录/兜底刷新，而非静默吞掉
      if (res.status === 401 || res.status === 403 || /invalid token|expired|unauthorized/i.test(body)) {
        throw new TokenExpiredError(`models token invalid ${res.status}: ${body}`)
      }
      throw new Error(`fetchModels failed ${res.status}: ${body}`)
    }
    // 网关响应：{ code, data: { data: [ {id, displayName, apiKey, baseUrl, ...} ] }, message }
    const raw = (await res.json()) as {
      code?: number
      message?: string
      error?: string
      data?: { data?: Array<Record<string, unknown>> }
      models?: Array<Record<string, unknown>>
    }
    // 网关错误响应（如 {"error":"invalid token"}），HTTP 200 也可能带 error 字段
    if (raw.error) {
      if (/invalid token|expired|unauthorized/i.test(raw.error)) {
        throw new TokenExpiredError(raw.error)
      }
      throw new Error(`fetchModels error: ${raw.error}`)
    }
    if (raw.code !== undefined && raw.code !== 0) {
      throw new Error(raw.message ?? `fetchModels code=${raw.code}`)
    }
    // 会员网关返回的就是「该会员当前可用模型」，被禁用的模型后端已不返回，无需客户端再猜禁用字段过滤
    const list = raw.data?.data ?? raw.models ?? []
    return list.map((m) => {
      const id = String(m.id ?? '')
      const name = String(m.displayName ?? m.name ?? id)
      // 仅在「网关未下发 effort 且模型支持思考(supportsReasoning=true)」时用内置表补档；否则保持网关原样（不注入）
      const builtinEffort =
        m.reasoningEffort != null || m.supportsReasoning !== true
          ? undefined
          : resolveBuiltinReasoningEffort(id)
      return {
        id,
        name,
        displayName: m.displayName != null ? String(m.displayName) : undefined,
        model: m.model != null ? String(m.model) : undefined,
        tier: 'flagship' as ModelTier,
        apiKey: String(m.apiKey ?? ''),
        baseUrl: String(m.baseUrl ?? ''),
        contextLength: typeof m.contextLength === 'number' ? m.contextLength : undefined,
        maxTokens: m.maxTokens != null ? Number(m.maxTokens) : undefined,
        temperature: m.temperature != null ? String(m.temperature) : undefined,
        supportsVision: m.supportsVision === true,
        supportsReasoning: m.supportsReasoning === true,
        reasoningEffort: m.reasoningEffort != null ? String(m.reasoningEffort) : builtinEffort?.defaultEffort,
        reasoningEfforts: builtinEffort?.efforts,
        provider: m.provider != null ? String(m.provider) : undefined,
        protocol: m.protocol === 'anthropic' || m.provider === 'anthropic' ? 'anthropic' : undefined,
        sortOrder: typeof m.sortOrder === 'number' ? m.sortOrder : undefined,
        description: m.description != null ? String(m.description) : undefined,
        source: m.source != null ? String(m.source) : undefined,
        modelType: m.modelType != null ? String(m.modelType) : undefined,
      }
    })
  }
}
