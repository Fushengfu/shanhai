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
}
