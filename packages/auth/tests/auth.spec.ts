import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { AuthService } from '../src/auth'
import { FileCredentialStore } from '../src/credential'

describe('AuthService', () => {
  it('密码 SHA-256 小写 hex', () => {
    expect(AuthService.sha256Hex('123456')).toBe(
      '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
    )
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
