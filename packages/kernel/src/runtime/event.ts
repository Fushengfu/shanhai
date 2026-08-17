import type { EventOptions } from '../types'

export type EventListener = (...args: unknown[]) => unknown

interface EventEntry {
  listener: EventListener
  options: EventOptions
}

/**
 * 事件总线：五种 dispatch 模式（对齐 Cordis）。
 *
 * - emit：同步执行，忽略返回值
 * - parallel：并发 await 所有监听器
 * - serial：顺序 await，直到某个返回 bail 值
 * - bail：同步执行，直到某个返回 bail 值
 * - waterfall：组合监听器，末参 next()，不调用即短路
 *
 * 监听器的撤销由 Context 层负责（ctx.on 把撤销函数挂到 fiber 副作用栈）。
 */
export class Events {
  private listeners = new Map<string, EventEntry[]>()

  on(name: string, listener: EventListener, options: EventOptions = {}): () => boolean {
    const entry: EventEntry = { listener, options }
    const list = this.listeners.get(name) ?? []
    list.push(entry)
    this.listeners.set(name, list)
    return () => {
      const arr = this.listeners.get(name)
      if (!arr) return false
      const idx = arr.indexOf(entry)
      if (idx >= 0) {
        arr.splice(idx, 1)
        return true
      }
      return false
    }
  }

  private get(name: string): EventListener[] {
    return (this.listeners.get(name) ?? []).map((e) => e.listener)
  }

  emit(name: string, ...args: unknown[]): void {
    for (const listener of this.get(name)) {
      listener(...args)
    }
  }

  async parallel(name: string, ...args: unknown[]): Promise<void> {
    await Promise.all(this.get(name).map((l) => Promise.resolve(l(...args))))
  }

  async serial(name: string, ...args: unknown[]): Promise<unknown> {
    for (const listener of this.get(name)) {
      const result = await listener(...args)
      if (result !== undefined && result !== false) return result
    }
    return undefined
  }

  bail(name: string, ...args: unknown[]): unknown {
    for (const listener of this.get(name)) {
      const result = listener(...args)
      if (result !== undefined && result !== false) return result
    }
    return undefined
  }

  waterfall(name: string, ...args: unknown[]): unknown {
    const listeners = this.get(name)
    const next = (i: number): unknown => {
      const listener = listeners[i]
      if (!listener) return undefined
      return listener(...args, () => next(i + 1))
    }
    return next(0)
  }
}
