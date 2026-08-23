import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginStore } from '../src/selfmod/inventory'

describe('PluginStore', () => {
  async function makeStore(): Promise<{ store: PluginStore; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'shanhai-store-'))
    return { store: new PluginStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) }
  }

  it('install 落盘 manifest.json，load 读回，list 列出', async () => {
    const { store, cleanup } = await makeStore()
    try {
      await store.install({ id: 'todo', name: '待办', purpose: 'x', installedAt: 1 })
      const meta = await store.load('todo')
      expect(meta?.id).toBe('todo')
      expect(meta?.name).toBe('待办')
      expect((await store.list()).map((m) => m.id)).toEqual(['todo'])
    } finally {
      await cleanup()
    }
  })

  it('install 覆盖式重装（升级），uninstall 删除目录', async () => {
    const { store, cleanup } = await makeStore()
    try {
      await store.install({ id: 'a', name: 'a', purpose: 'x', installedAt: 1 })
      await store.install({ id: 'a', name: 'a-v2', purpose: 'x', installedAt: 2 })
      expect((await store.load('a'))?.name).toBe('a-v2')

      await store.uninstall('a')
      expect(await store.load('a')).toBeUndefined()
      expect(await store.list()).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })

  it('路径穿越防护：非法 id 抛错', async () => {
    const { store, cleanup } = await makeStore()
    try {
      await expect(store.install({ id: '../evil', name: 'x', purpose: 'x', installedAt: 1 })).rejects.toThrow(/非法插件 id/)
      await expect(store.uninstall('a/b')).rejects.toThrow(/非法插件 id/)
    } finally {
      await cleanup()
    }
  })

  it('load 不存在或目录不存在返回 undefined / 空', async () => {
    const { store, cleanup } = await makeStore()
    try {
      expect(await store.load('nope')).toBeUndefined()
      expect(await store.list()).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })
})
