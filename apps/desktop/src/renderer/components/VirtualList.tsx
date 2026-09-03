import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as React from 'react'

/**
 * 轻量窗口化列表：只渲染「视口 + 缓冲」内的块，视口外用上下 spacer 占位，
 * 用于消息流这类「块高度可变、顺序 append」的长列表，从根上降低 DOM 节点数与内存占用。
 *
 * 与 content-visibility:auto 的本质区别：content-visibility 只跳过布局/绘制，DOM 节点仍在；
 * 本组件真正不渲染视口外的块，因此能显著减少 React 提交与 DOM 节点数（内存）。
 *
 * 高度测量：每个已渲染块用 ResizeObserver 实测，写入 heights（按全局块 index 存）；
 * 未测量的块用 estimateSize 估算。滚动时按「前缀高度和 + 二分」反推应渲染区间。
 */
export function VirtualList({
  items,
  containerRef,
  estimateSize = 120,
  overscan = 6,
  onScroll,
  isEmpty = false,
  empty = null,
  footer = null,
  style,
}: {
  /** 按顺序构建好的块节点（每个带稳定 key）。注意：只构建 element、不展开 DOM，本身很轻 */
  items: React.ReactNode[]
  /** 滚动容器 ref，由组件挂到滚动 div 上（调用方仍用它做吸底 scrollTop=scrollHeight） */
  containerRef: React.RefObject<HTMLDivElement>
  /** 单块估算高度（px），未测量前占位用 */
  estimateSize?: number
  /** 上下额外渲染的缓冲区块数 */
  overscan?: number
  onScroll?: () => void
  isEmpty?: boolean
  empty?: React.ReactNode
  /** 不参与窗口化的附加内容（流式气泡 / 继续执行按钮等），渲染在末尾 */
  footer?: React.ReactNode
  style?: React.CSSProperties
}): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(600)
  const [heights, setHeights] = useState<number[]>(() =>
    new Array(items.length).fill(estimateSize),
  )

  const measureRO = useRef<ResizeObserver | null>(null)
  const measureRefs = useRef(new Map<number, HTMLDivElement>())

  // items 数量变化时，扩展 heights（前部实测值保留，尾部新位用 estimateSize 补齐）
  useEffect(() => {
    setHeights((prev) => {
      if (prev.length === items.length) return prev
      const next = prev.slice()
      next.length = items.length
      for (let i = 0; i < next.length; i++) {
        const v = next[i]
        if (v == null || v <= 0) next[i] = estimateSize
      }
      return next
    })
  }, [items.length, estimateSize])

  // 观察滚动容器 clientHeight（窗口 resize / 布局变化）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = (): void => setViewHeight(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef])

  // 观察每个已渲染块的实测高度，写入 heights 触发重算
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      let changed = false
      setHeights((prev) => {
        const next = prev.slice()
        for (const entry of entries) {
          const el = entry.target as HTMLElement
          const idx = Number(el.dataset.vindex)
          if (Number.isNaN(idx)) continue
          let h = 0
          if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
            const first = entry.borderBoxSize[0]
            h = first ? first.blockSize : entry.contentRect.height
          } else {
            h = entry.contentRect.height
          }
          const cur = next[idx]
          if (h > 0 && cur !== h) {
            next[idx] = h
            changed = true
          }
        }
        return changed ? next : prev
      })
    })
    measureRO.current = ro
    return () => ro.disconnect()
  }, [])

  const setNodeRef = useCallback(
    (idx: number) =>
      (el: HTMLDivElement | null): void => {
        const ro = measureRO.current
        const prev = measureRefs.current.get(idx)
        if (prev && prev !== el && ro) ro.unobserve(prev)
        if (el) {
          measureRefs.current.set(idx, el)
          el.dataset.vindex = String(idx)
          ro?.observe(el)
        } else {
          measureRefs.current.delete(idx)
        }
      },
    [],
  )

  // 计算渲染区间与上下占位高度
  const range = useMemo(() => {
    const count = items.length
    if (count === 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 }
    const getH = (i: number): number => heights[i] ?? estimateSize
    const prefix: number[] = new Array(count + 1)
    prefix[0] = 0
    for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i]! + getH(i)
    const total = prefix[count] ?? 0

    const overscanPx = overscan * estimateSize
    const top = Math.max(0, scrollTop - overscanPx)
    const bottom = scrollTop + viewHeight + overscanPx

    // 二分：第一个 prefix[i+1] > top 的 i
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((prefix[mid + 1] ?? 0) <= top) lo = mid + 1
      else hi = mid
    }
    const start = Math.max(0, Math.min(count - 1, lo))

    // 二分：第一个 prefix[i+1] > bottom 的 i
    let lo2 = start
    let hi2 = count
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1
      if ((prefix[mid + 1] ?? 0) <= bottom) lo2 = mid + 1
      else hi2 = mid
    }
    const end = Math.min(count, lo2 + 1)

    return { start, end, topPad: prefix[start] ?? 0, bottomPad: total - (prefix[end] ?? 0) }
  }, [items.length, heights, scrollTop, viewHeight, estimateSize, overscan])

  const visibleItems = useMemo(() => {
    if (items.length === 0) return []
    const out: React.ReactNode[] = []
    for (let i = range.start; i < range.end; i++) {
      const item = items[i]
      if (item == null) continue
      const idx = i
      const key = (item as React.ReactElement<{ key?: React.Key }> | null)?.key ?? idx
      out.push(
        <div
          key={key}
          ref={setNodeRef(idx)}
          style={{ width: '100%', minWidth: 0, flexShrink: 0 }}
        >
          {item}
        </div>,
      )
    }
    return out
  }, [items, range.start, range.end, setNodeRef])

  const handleScroll = useCallback((): void => {
    const el = containerRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    onScroll?.()
  }, [containerRef, onScroll])

  return (
    <div ref={containerRef} onScroll={handleScroll} style={style}>
      {isEmpty ? (
        empty
      ) : (
        <>
          <div style={{ height: range.topPad, width: '100%', flexShrink: 0 }} />
          {visibleItems}
          <div style={{ height: range.bottomPad, width: '100%', flexShrink: 0 }} />
          {footer}
        </>
      )}
    </div>
  )
}