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
  /** 是否为用户自定义模型（true 自定义 / false 或 undefined 系统内置） */
  custom?: boolean
}

export interface AuthSession {
  token: string
  username: string
  nickname?: string
  avatar?: string
  balance?: number
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
    const raw = (await res.json()) as {
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
    if (raw.code !== undefined && raw.code !== 0) {
      throw new Error(raw.message ?? `login failed code=${raw.code}`)
    }
    const token = raw.data?.token ?? raw.token ?? raw.data?.memberToken ?? raw.memberToken ?? raw.data?.access_token ?? raw.access_token
    if (!token) {
      throw new Error(`login response missing token: ${JSON.stringify(raw).slice(0, 300)}`)
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
        provider: m.provider != null ? String(m.provider) : undefined,
        protocol: m.protocol === 'anthropic' || m.provider === 'anthropic' ? 'anthropic' : undefined,
        sortOrder: typeof m.sortOrder === 'number' ? m.sortOrder : undefined,
        description: m.description != null ? String(m.description) : undefined,
        source: m.source != null ? String(m.source) : undefined,
      }
    })
  }
}
