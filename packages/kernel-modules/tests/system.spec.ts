import { describe, it, expect } from 'vitest'
import { parseBootManifest } from '../src/manifest'
import { ClientModuleRegistry } from '../src/registry'
import { ClientModuleSystem } from '../src/client/system'
import { SlotRegistry } from '../src/client/slot'

describe('K3 模块系统', () => {
  it('parseBootManifest 校验合法清单', () => {
    const manifest = parseBootManifest({
      modules: [{ id: 'a', path: '/a.js' }],
      plugins: [{ id: 'p', moduleId: 'a', slots: ['main'] }],
    })
    expect(manifest.modules[0]?.id).toBe('a')
  })

  it('parseBootManifest 非法输入抛错', () => {
    expect(() => parseBootManifest(null)).toThrow()
    expect(() => parseBootManifest({ modules: 'x', plugins: [] })).toThrow()
    expect(() => parseBootManifest({ modules: [], plugins: [{ id: 1 }] })).toThrow()
  })

  it('ClientModuleRegistry 组合清单', () => {
    const reg = new ClientModuleRegistry()
    reg.registerModule('a', '/a.js')
    reg.registerPlugin({ id: 'p', moduleId: 'a', slots: ['main'] })
    const manifest = reg.buildManifest()
    expect(manifest.modules).toEqual([{ id: 'a', path: '/a.js' }])
    expect(manifest.plugins).toEqual([{ id: 'p', moduleId: 'a', slots: ['main'] }])
  })

  it('ClientModuleSystem 懒加载 + 缓存', () => {
    const sys = new ClientModuleSystem()
    let calls = 0
    sys.register('a', () => {
      calls++
      return { x: 1 }
    })
    expect(calls).toBe(0) // 懒加载
    expect(sys.require('a')).toEqual({ x: 1 })
    expect(calls).toBe(1)
    expect(sys.require('a')).toEqual({ x: 1 }) // 缓存
    expect(calls).toBe(1)
  })

  it('ClientModuleSystem 循环依赖返回部分导出（不无限递归）', () => {
    const sys = new ClientModuleSystem()
    sys.register('a', () => ({ name: 'a', b: sys.require('b') }))
    sys.register('b', () => ({ name: 'b', a: sys.require('a') }))
    const a = sys.require('a') as { name: string; b: { a: unknown } }
    expect(a.name).toBe('a')
    expect(a.b.a).toBeUndefined() // 循环时拿到部分导出
  })

  it('ClientModuleSystem invalidate 失效重载', () => {
    const sys = new ClientModuleSystem()
    sys.register('a', () => ({ v: 1 }))
    expect(sys.require('a')).toEqual({ v: 1 })
    sys.invalidate('a')
    sys.register('a', () => ({ v: 2 }))
    expect(sys.require('a')).toEqual({ v: 2 })
  })

  it('SlotRegistry 注册、渲染与撤销', () => {
    const slots = new SlotRegistry<string>()
    const off = slots.register({ slot: 'main', id: 'a', component: 'CompA' })
    expect(slots.renderSlot('main').map((r) => r.id)).toEqual(['a'])
    off()
    expect(slots.renderSlot('main')).toEqual([])
  })
})
