import { createHash } from 'node:crypto'

/** 模型路由三层 */
export type ModelTier = 'flagship' | 'value' | 'vision'

export interface GatewayModel {
  id: string
  name: string
  tier: ModelTier
  apiKey: string
  baseUrl: string
}

export interface AuthSession {
  token: string
  username: string
}

export interface AuthServiceOptions {
  /** 网关基地址（会员体系），如 https://agent.bjctykj.com */
  baseUrl: string
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
      throw new Error(`login failed ${res.status}: ${await res.text()}`)
    }
    const data = (await res.json()) as { token?: string }
    if (!data.token) throw new Error('login response missing token')
    return { token: data.token, username }
  }

  async logout(): Promise<void> {
    // 无状态 JWT，客户端只需清除本地凭证（由 CredentialStore.clear 处理）
  }

  async fetchModels(token: string): Promise<GatewayModel[]> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/api/member/models`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(`fetchModels failed ${res.status}: ${await res.text()}`)
    }
    const data = (await res.json()) as { models?: GatewayModel[] } | GatewayModel[]
    return Array.isArray(data) ? data : (data.models ?? [])
  }
}
