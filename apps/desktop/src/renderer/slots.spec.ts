import { describe, it, expect, afterEach } from 'vitest'
import { registerSlot, getSlotComponents } from './slots'

/** 占位组件：只验证「注册/覆盖/回退」语义，不渲染真实 UI */
const CoreComposer = (): null => null
const DynComposer = (): null => null

describe('UI 插槽替换（renderer slots 热替换，K5 自我迭代 UI 闭环）', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.()
    }
  })

  it('核心 UI 插件先注册，selfmod 动态包后注册即热替换（后注册覆盖）', () => {
    disposers.push(registerSlot('shell.composer', 'core:composer', 'core', CoreComposer))
    disposers.push(registerSlot('shell.composer', 'dyn-1:btn', 'dyn-1', DynComposer))
    const comps = getSlotComponents('shell.composer')
    // 追加顺序：核心在前，动态在后；SlotView 取最后一个 = 动态组件（热替换）
    expect(comps.map((c) => c.id)).toEqual(['core:composer', 'dyn-1:btn'])
    expect(comps[comps.length - 1]?.id).toBe('dyn-1:btn')
  })

  it('selfmod 动态包注销后回退到核心组件', () => {
    disposers.push(registerSlot('shell.composer', 'core:composer', 'core', CoreComposer))
    const off = registerSlot('shell.composer', 'dyn-1:btn', 'dyn-1', DynComposer)
    expect(getSlotComponents('shell.composer').map((c) => c.id)).toEqual(['core:composer', 'dyn-1:btn'])
    off()
    const comps = getSlotComponents('shell.composer')
    expect(comps.map((c) => c.id)).toEqual(['core:composer'])
    expect(comps[comps.length - 1]?.id).toBe('core:composer')
  })

  it('dynamic-extension 多组件追加，互不覆盖（扩展区语义区别于核心 slot）', () => {
    disposers.push(registerSlot('dynamic-extension', 'dyn-1:a', 'dyn-1', CoreComposer))
    disposers.push(registerSlot('dynamic-extension', 'dyn-1:b', 'dyn-1', DynComposer))
    expect(getSlotComponents('dynamic-extension').map((c) => c.id)).toEqual(['dyn-1:a', 'dyn-1:b'])
  })

  it('追加型插槽（composer.below）多组件追加，互不覆盖（AppendSlotView 语义）', () => {
    disposers.push(registerSlot('composer.below', 'dyn-1:btn-a', 'dyn-1', CoreComposer))
    disposers.push(registerSlot('composer.below', 'dyn-2:btn-b', 'dyn-2', DynComposer))
    const comps = getSlotComponents('composer.below')
    // 追加型：全部保留，互不覆盖（区别于 shell.composer 的「取最后一个」覆盖语义）
    expect(comps.map((c) => c.id)).toEqual(['dyn-1:btn-a', 'dyn-2:btn-b'])
    expect(comps.length).toBe(2)
  })
})
