import { describe, it, expect } from 'vitest'
import { Kernel } from '../src/runtime/kernel'
import { createContext } from '../src/runtime/context'

describe('Fiber 生命周期', () => {
  it('插件加载后状态为 ACTIVE，卸载后 DISPOSED', async () => {
    const kernel = new Kernel()
    const fiber = kernel.plugin(() => {})
    await fiber
    expect(fiber.state).toBe('ACTIVE')
    await fiber.dispose()
    expect(fiber.state).toBe('DISPOSED')
  })

  it('apply 抛错置 FAILED 并 reject', async () => {
    const kernel = new Kernel()
    const fiber = kernel.plugin(() => {
      throw new Error('boom')
    })
    await expect(fiber).rejects.toThrow('boom')
    expect(fiber.state).toBe('FAILED')
  })
})

describe('副作用（registrations are effects）', () => {
  it('effect 注册的 disposer 逆序撤销', async () => {
    const order: string[] = []
    const kernel = new Kernel()
    const fiber = kernel.plugin((ctx) => {
      ctx.effect(() => {
        order.push('a')
        return () => order.push('undo-a')
      })
      ctx.effect(() => {
        order.push('b')
        return () => order.push('undo-b')
      })
    })
    await fiber
    expect(order).toEqual(['a', 'b'])
    await fiber.dispose()
    expect(order).toEqual(['a', 'b', 'undo-b', 'undo-a'])
  })

  it('支持 async disposer', async () => {
    const order: string[] = []
    const kernel = new Kernel()
    const fiber = kernel.plugin((ctx) => {
      ctx.effect(() => async () => {
        order.push('undo-async')
      })
    })
    await fiber
    await fiber.dispose()
    expect(order).toEqual(['undo-async'])
  })
})

describe('Context 服务解析（Proxy）', () => {
  it('ctx.xxx 直接读服务', async () => {
    let resolved: unknown
    const kernel = new Kernel()
    const fiber = kernel.plugin((ctx) => {
      ctx.provide('session', { id: 's1' })
      resolved = ctx.session
    })
    await fiber
    expect(resolved).toEqual({ id: 's1' })
  })

  it('extend 子上下文继承父服务', () => {
    const parent = createContext()
    parent.provide('config', { theme: 'dark' })
    const child = parent.extend()
    expect(child.config).toEqual({ theme: 'dark' })
  })
})

describe('事件总线', () => {
  it('emit 触发监听器', () => {
    const ctx = createContext()
    const got: unknown[] = []
    ctx.on('ping', (...args) => {
      got.push(...args)
    })
    ctx.emit('ping', 1, 2)
    expect(got).toEqual([1, 2])
  })

  it('waterfall 短路：不调 next 则后续不执行', () => {
    const ctx = createContext()
    const order: string[] = []
    ctx.on('flow', () => {
      order.push('first')
      // 不调用 next → 短路
    })
    ctx.on('flow', () => {
      order.push('second') // 不应执行
    })
    ctx.waterfall('flow', 0)
    expect(order).toEqual(['first'])
  })

  it('waterfall 透传：调 next 则后续执行', () => {
    const ctx = createContext()
    const order: string[] = []
    ctx.on('flow', (_v, next) => {
      order.push('first')
      return next()
    })
    ctx.on('flow', () => {
      order.push('second')
    })
    ctx.waterfall('flow', 0)
    expect(order).toEqual(['first', 'second'])
  })

  it('监听器随 fiber 卸载自动撤销', async () => {
    const kernel = new Kernel()
    const ctx = kernel.ctx
    const got: unknown[] = []
    const fiber = kernel.plugin((c) => {
      c.on('tick', () => got.push(1))
    })
    await fiber
    ctx.emit('tick')
    expect(got).toEqual([1])
    await fiber.dispose()
    ctx.emit('tick')
    expect(got).toEqual([1]) // 撤销后不再触发
  })
})
