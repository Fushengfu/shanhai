import { useEffect, useRef, type RefObject } from 'react'

/**
 * 下拉浮层的「点**本窗口内**外面 / 按 Esc → 收起」统一实现。
 *
 * 口径（用户已确认，与普通会话窗口的下拉保持一致）：**只处理本窗口内的外点**。
 * 下面两类「点到窗口之外」的收起路径**刻意不做**（曾实现过，按用户要求撤掉）：
 *  - `window` 的 `blur`：点别的软件 / 系统桌面 / 另一个山海窗口；
 *  - 主进程 `ui:dismiss-popups` 广播：点山海桌面壳 / Dock（它们是 focusable:false 的独立窗口，
 *    点上去本来也不会让本窗口失焦）。
 * 现在下拉只在「本窗口内点到别处」或「按 Esc」时收起，跨窗口/点到窗口外保持展开。
 *
 * 两条收起路径：
 *  1) document `mousedown`（**capture 阶段**，不用 click）：mousedown 先于 React 合成 click 派发，
 *     不会出现「同一次点击先关又开」；挂 capture 是因为 React 的合成事件监听在 root 容器上，
 *     浮层内部任何元素（含 stopPropagation 的按钮）都拦不住它在最外层先收到。
 *     + `containerRef.contains` 判定：点容器（触发按钮 + 面板）内不算「外面」，
 *     因此触发按钮自身的 toggle（再点一次收起）语义得以保留、不会被误判成外点。
 *  2) `Escape` 键。
 *
 * 监听只在 open 期间挂载，关闭/卸载时全部移除；onDismiss 走 ref 取最新值、不进依赖数组，
 * 所以常驻窗口里反复开合不会累积监听器，也不会因父组件每次 render 换回调而反复重挂。
 */
export interface DismissOnClickOutsideOptions {
  /** 当前是否展开；false 时不挂任何监听 */
  open: boolean
  /** 浮层容器 ref（触发按钮与面板都在其内） */
  containerRef: RefObject<HTMLElement>
  /** 收起回调 */
  onDismiss: () => void
}

export function useDismissOnClickOutside(opts: DismissOnClickOutsideOptions): void {
  const { open, containerRef } = opts
  // 用 ref 持有最新回调，避免它进依赖导致每次 render 都重挂监听
  const dismissRef = useRef(opts.onDismiss)
  dismissRef.current = opts.onDismiss

  useEffect(() => {
    if (!open) return

    const dismiss = (): void => dismissRef.current()

    const onDocMouseDown = (e: MouseEvent): void => {
      const el = containerRef.current
      if (el && !el.contains(e.target as Node)) dismiss()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }

    document.addEventListener('mousedown', onDocMouseDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      // 移除必须与添加用同一个 capture 标志，否则摘不掉（会静默泄漏一个永不移除的监听器）
      document.removeEventListener('mousedown', onDocMouseDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, containerRef])
}
