/**
 * UI slot 组合（client 半）。
 *
 * 客户端插件通过 slots.register({ slot, id, component }) 挂真实组件，
 * renderSlot(slot) 消费，组件 props 由框架派生，业务代码不手写订阅。
 */
export interface SlotRegistration<C = unknown> {
  slot: string
  id: string
  component: C
}

export class SlotRegistry<C = unknown> {
  private readonly registrations = new Map<string, SlotRegistration<C>[]>()

  register(reg: SlotRegistration<C>): () => void {
    const list = this.registrations.get(reg.slot) ?? []
    list.push(reg)
    this.registrations.set(reg.slot, list)
    return () => {
      const arr = this.registrations.get(reg.slot)
      if (!arr) return
      const idx = arr.indexOf(reg)
      if (idx >= 0) arr.splice(idx, 1)
    }
  }

  renderSlot(slot: string): SlotRegistration<C>[] {
    return this.registrations.get(slot) ?? []
  }

  /** 列出所有已注册的 slot 名（含空注册） */
  listSlots(): string[] {
    return [...this.registrations.keys()]
  }
}

/**
 * 核心 UI 插槽清单（shell 布局的固定座位）。
 * 作为「UI slot 契约」定义在 kernel-modules（双端共享）：renderer 用它渲染内置 UI 插件，
 * runtime 的 selfmod plugin_inspect 用它向 agent 暴露真实 UI 表面（哪些座位可挂/替换组件）。
 *
 * 插槽分两类语义（renderer 侧渲染方式不同）：
 * - 覆盖型（override）：shell.* 主区块 + dynamic-extension。SlotView 取「最后注册」的组件渲染，
 *   后注册的组件会「整体替换」核心 UI 区块，注销后回退到核心组件（热替换 + 可回滚）。
 * - 追加型（append）：composer.below / composer.actions / header.actions / chat.below。
 *   核心 UI 区块内部预留的「小插槽」，AppendSlotView 把全部注册组件依次渲染（互不覆盖），
 *   用于「往输入框下方 / 工具栏 / 顶栏右侧 / 消息流下方追加按钮或小组件」这类局部扩展。
 */
export const CORE_SLOTS = [
  'shell.sidebar',
  'shell.header',
  'shell.chat',
  'shell.composer',
  'shell.statusbar',
  'shell.welcome',
  'shell.panels',
  'shell.overlays',
  'dynamic-extension',
  // —— 追加型扩展点（核心区块内部预留的追加位）——
  'composer.below',
  'composer.actions',
  'header.actions',
  'chat.below',
] as const

/** 追加型插槽清单：AppendSlotView 用「追加」语义渲染（map 全部，互不覆盖） */
export const APPEND_SLOTS = ['composer.below', 'composer.actions', 'header.actions', 'chat.below'] as const
