import { SlotRegistry } from '@shanhai/kernel-modules/client'
import type { SlotRegistration } from '@shanhai/kernel-modules/client'
import { useSyncExternalStore } from 'react'
import type * as React from 'react'

/**
 * UI 插槽组合（client 半）：渲染进程 UI 组合的唯一数据源。
 *
 * 对齐 K3 模块系统——UI 区块（内置 UI 插件 / selfmod 动态包 browser 半）都通过
 * `slots.register({ slot, id, component })` 挂真实组件，`useSlotComponents(slot)` 消费渲染。
 * 这里用 kernel-modules 的 SlotRegistry 作为底层存储（替代 App.tsx 里手写的 setClientComponents），
 * 再包一层 React 响应式订阅：register/unregister 时通知重渲染。
 */

/** 挂到某个 slot 的组件元信息（含所属动态包 pkgId，用于卸载时过滤） */
export interface SlotComponent {
  /** 完整注册 id（形如 `<pkgId>:<regId>`） */
  id: string
  pkgId: string
  Component: React.ComponentType
}

/** 全局唯一 SlotRegistry（UI 组合的单一数据源） */
const registry = new SlotRegistry<SlotComponent>()

// —— 响应式订阅：SlotRegistry 本身非响应式，这里用 useSyncExternalStore 桥接 React ——
const listeners = new Set<() => void>()
let version = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getVersion(): number {
  return version
}

function notify(): void {
  version++
  listeners.forEach((l) => l())
}

/** 注册组件到 slot，返回注销函数（逆序撤销，对齐「注册即副作用」） */
export function registerSlot(slot: string, id: string, pkgId: string, Component: React.ComponentType): () => void {
  const reg: SlotRegistration<SlotComponent> = { slot, id, component: { id, pkgId, Component } }
  const dispose = registry.register(reg)
  notify()
  return () => {
    dispose()
    notify()
  }
}

/** 纯函数：获取 slot 的组件列表（不触发订阅，供单测与 SlotView 复用） */
export function getSlotComponents(slot: string): SlotComponent[] {
  return registry.renderSlot(slot).map((r) => r.component)
}

/** 订阅指定 slot 的组件列表（响应式 hook，register/unregister 时自动重渲染） */
export function useSlotComponents(slot: string): SlotComponent[] {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return getSlotComponents(slot)
}

/** 渲染某个 slot 的通用组件（shell 组合根用它在布局里渲染各 UI 插件）。
 * 采用「后注册覆盖」语义：返回最后注册的组件——核心 UI 插件先注册，selfmod 动态包后注册时即「热替换」核心组件，
 * 动态包注销后自动回退到核心组件（对齐 K5「slots 热替换 + 可回滚」）。
 */
export function SlotView({ slot }: { slot: string }): React.ReactElement | null {
  const comps = useSlotComponents(slot)
  if (comps.length === 0) return null
  const active = comps[comps.length - 1]
  if (!active) return null
  return <active.Component key={active.id} />
}

/** 追加型插槽渲染：把该 slot 上「全部注册的组件」依次渲染（互不覆盖、互不替换）。
 * 用于 composer.below / composer.actions / header.actions / chat.below 等核心区块内部的局部扩展点，
 * agent 往这些插槽挂按钮/小组件时即「追加显示」，而非整体替换核心区块。
 */
export function AppendSlotView({ slot }: { slot: string }): React.ReactElement | null {
  const comps = useSlotComponents(slot)
  if (comps.length === 0) return null
  return (
    <>
      {comps.map((c) => (
        <c.Component key={c.id} />
      ))}
    </>
  )
}
