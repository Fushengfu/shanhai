import type { Disposable, Effect } from '../types'

/**
 * 副作用栈：注册即收集 disposer，卸载时逆序撤销。
 * 对齐 Cordis 核心约定——「注册即副作用」（registrations are effects），
 * 所有贡献都返回 disposer，fiber 卸载时逆序撤销。
 */
export class DisposerStack {
  private disposers: Disposable[] = []

  /** 收集一个 effect 返回体 */
  collect(effect: Effect): void {
    collectEffect(effect, (d) => this.disposers.push(d))
  }

  /** 逆序撤销全部 disposer（单个失败不阻断其余） */
  async dispose(): Promise<void> {
    const disposers = this.disposers.splice(0).reverse()
    for (const disposer of disposers) {
      try {
        await disposer()
      } catch (err) {
        // 撤销失败响亮记录，不静默吞掉
        console.error('[kernel] disposer failed:', err)
      }
    }
  }
}

/**
 * 把 effect 返回体规整为 disposer，逐个交给 onDisposable 收集。
 * 支持四种形式：Disposable / Promise<Disposable> / Iterable / AsyncIterable。
 */
export function collectEffect(
  effect: Effect,
  onDisposable: (d: Disposable) => void,
): void {
  if (typeof effect === 'function') {
    onDisposable(effect)
    return
  }
  if (effect == null) {
    return
  }
  if (Symbol.asyncIterator in effect) {
    void (async () => {
      for await (const d of effect as AsyncIterable<Disposable>) {
        if (d) onDisposable(d)
      }
    })()
    return
  }
  if (Symbol.iterator in effect) {
    for (const d of effect as Iterable<Disposable>) {
      if (d) onDisposable(d)
    }
    return
  }
  // Promise<Disposable>
  void Promise.resolve(effect as Promise<Disposable>).then((d) => {
    if (d) onDisposable(d)
  })
}
