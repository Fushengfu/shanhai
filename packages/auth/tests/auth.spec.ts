import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { AuthService, TokenExpiredError } from '../src/auth'
import { FileCredentialStore } from '../src/credential'

describe('AuthService', () => {
  it('密码 SHA-256 小写 hex', () => {
    expect(AuthService.sha256Hex('123456')).toBe(
      '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
    )
  })
})

describe('AuthService.fetchModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('原样返回网关下发的模型列表（网关已过滤禁用模型，客户端不再做字段猜测过滤）', async () => {
    const svc = new AuthService({ baseUrl: 'https://example.com' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            data: [
              { id: 'm1', displayName: '模型1' },
              { id: 'm2', displayName: '模型2', contextLength: 256000 },
            ],
          },
        }),
      })) as unknown as typeof fetch,
    )

    const models = await svc.fetchModels('token')
    expect(models.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(models[1].contextLength).toBe(256000)
  })

  it('HTTP 401 时抛 TokenExpiredError', async () => {
    const svc = new AuthService({ baseUrl: 'https://example.com' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":"invalid token"}',
      })) as unknown as typeof fetch,
    )
    await expect(svc.fetchModels('token')).rejects.toThrow(TokenExpiredError)
  })

  it('HTTP 200 但 body 含 {"error":"invalid token"} 时抛 TokenExpiredError', async () => {
    const svc = new AuthService({ baseUrl: 'https://example.com' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ error: 'invalid token' }),
      })) as unknown as typeof fetch,
    )
    await expect(svc.fetchModels('token')).rejects.toThrow(TokenExpiredError)
  })
})

describe('FileCredentialStore', () => {
  it('save 后 load 可读，clear 后为 null，密码不落盘', async () => {
    const dir = join('/tmp', `shanhai-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const store = new FileCredentialStore(join(dir, 'config.json'))
    expect(await store.load()).toBeNull()

    await store.save({ username: 'alice', token: 'jwt-token' })
    const loaded = await store.load()
    expect(loaded?.username).toBe('alice')
    expect(loaded?.token).toBe('jwt-token')
    // 落盘内容不含密码
    const raw = await fs.readFile(join(dir, 'config.json'), 'utf8')
    expect(raw).not.toContain('password')

    await store.clear()
    expect(await store.load()).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
