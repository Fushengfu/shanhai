import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createContext } from '../src/runtime/context'
import { signPayload, verifyPayload, stableStringify, FileSnapshotStore } from '../src/security/signing'

describe('K4 能力清单（least privilege）', () => {
  it('越界 provide 抛错', () => {
    const ctx = createContext()
    const guarded = ctx.guard({ provide: ['a'] })
    expect(() => guarded.provide('b', {})).toThrow('capability denied')
    expect(() => guarded.provide('a', {})).not.toThrow()
  })

  it('越界 consume 抛错', () => {
    const ctx = createContext()
    const guarded = ctx.guard({ consume: ['a'] })
    expect(() => guarded.b).toThrow('capability denied')
  })
})

describe('K4 Ed25519 签名', () => {
  it('验签成功，篡改失败', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const payload = { name: 'p', version: '1.0.0' }
    const sig = signPayload(payload, priv)
    expect(verifyPayload(payload, sig, pub)).toBe(true)
    expect(verifyPayload({ ...payload, version: '2.0.0' }, sig, pub)).toBe(false)
  })

  it('stableStringify 键序稳定', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })
})

describe('K4 文件快照回滚', () => {
  it('snapshot → 修改 → rollback 恢复 → discard', async () => {
    const dir = join('/tmp', `shanhai-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const store = new FileSnapshotStore(dir)
    const file = join(dir, 'f.txt')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, 'v1')
    const id = await store.snapshot(file)
    await fs.writeFile(file, 'v2')
    await store.rollback(file, id)
    expect(await fs.readFile(file, 'utf8')).toBe('v1')
    await store.discard(file, id)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
