import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * 【P4】私信消息流的滚动行为（打开会话定位最新一条 / 自己发的立刻可见 / 收到新私信分情况跟随 /
 * 「加载更早」锚定原来看的那条），以及配套的「↓ N 条新消息」浮标计数。
 *
 * 为什么单独成文件、且只吃一个「签名」而不是消息数组本身：
 *  任务59 刚把私信面板的「一闪一闪」消掉（窄订阅 + 内容指纹守卫），滚动这套如果写成
 *  「每次重渲染都量一次 scrollHeight 再滚」就等于把闪烁请回来。这里的全部触发条件都是
 *  **原始值签名**（channelId / count / firstKey / lastKey），effect 依赖数组里也只有这四个原始值：
 *  面板因无关原因重渲染（会员通道广播、窄订阅字段变化）时，签名不变 → effect 不跑 → 一次 DOM 读写都不做。
 *
 * 三条实现取向（都跟「不闪」有关，写死在这里免得后人改回去）：
 *  1. 滚动一律用 `behavior:'auto'`（瞬移），不用 smooth 动画 —— 平滑滚动本身就是一段可见的位移动画；
 *     只有用户**主动点浮标**时才 smooth（那是用户自己发起的动作，期待有动画）。
 *  2. 「是否在底部」用 ref 记录，不在 scroll 事件里 setState：滚动事件每秒能来几十次，
 *     setState 会把任务59 消掉的抖动放大回来。唯一一次 setState 是「用户滚回底部且浮标非零」时清浮标。
 *  3. 用 layout 阶段（DOM 变更后、浏览器绘制前）改 scrollTop → 用户看不到中间态，不会「闪一下跳到顶」。
 */

/**
 * 距底多少像素算「在底部附近」→ 新消息跟随滚到底；超过则**不拽回**，只出浮标。
 * 80px 的取值依据：一条普通文本气泡约 40px、一条带缩略图的气泡约 200px+，
 * 取 80 意味着「只往上翻了一两条」仍然跟随（微信口径），翻到第三条以上就不再打扰。
 */
export const NEAR_BOTTOM_PX = 80

/** 消息流的内容签名：只放原始值，不放数组引用（引用每次都变 = effect 每轮都跑） */
export interface DmMessageSignature {
  /** 会话通道：变了就是「切换会话」，一律定位到最新一条 */
  channelId: string
  /** 消息条数（不含时间分隔线：浮标要报的是「几条新消息」） */
  count: number
  /** 最早一条的 key（变了 = 顶部插了内容 = 「加载更早」） */
  firstKey: string
  /** 最新一条的 key（变了 = 尾部有新消息） */
  lastKey: string
}

/**
 * 滚动计划。用「三个独立开关」而不是单个枚举，是因为**顶部插入与尾部新增可能同一次发生**：
 * 用户点「加载更早」的那一瞬间恰好有新私信到达 → 主进程返回的合并会话里两头都变了。
 * 若只允许一种动作，要么把用户拽回底部（违反硬指标 4），要么漏掉「N 条新消息」提示（违反硬指标 3）。
 */
export interface DmScrollPlan {
  /** 锚定：把 scrollTop 补上顶部新增的高度，让用户原来看的那条不动 */
  anchor: boolean
  /** 跟随：滚到最新一条（打开会话 / 贴底时来了新消息 / 最后一条被原地替换后仍贴底） */
  follow: boolean
  /** 浮标：这次在尾部新增了几条（用户正在往上翻时才累计） */
  badge: number
  /** 切会话时把上一次的浮标清零 */
  resetBadge: boolean
}

export interface DmScrollController {
  /** 挂到滚动容器上（用 React 18 的 RefObject<HTMLDivElement> 口径，与 useDismissOnClickOutside 一致） */
  scrollRef: RefObject<HTMLDivElement>
  /** 用户往上翻历史期间收到的新消息条数（>0 才渲染浮标；到底 / 切会话 / 点浮标 / 自己发一条都清零） */
  newCount: number
  /** 当前是否贴着底部（ref，不触发渲染；发送时用来强制跟随） */
  atBottomRef: RefObject<boolean>
  /** 滚到最新一条（smooth 只给用户主动点击浮标那条路径用） */
  scrollToBottom: (smooth?: boolean) => void
  /** 挂到滚动容器的 onScroll 上 */
  handleScroll: () => void
}

/** SSR（node 里渲成 HTML 做断言）没有布局，useLayoutEffect 会告警：无 window 时退回 useEffect */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function distanceToBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

/**
 * 签名 → 滚动计划。抽成纯函数是为了能被 node 直接断言（真实 DOM 里「有没有跳回底部」这件事
 * 静态验不了，但「什么输入判成哪种动作」可以，界面观感仍标需实测）。
 */
export function decideScrollPlan(prev: DmMessageSignature, next: DmMessageSignature, atBottom: boolean): DmScrollPlan {
  // 切换会话（含「自动打开第一个会话」那条路径）：一律定位到最新一条，并清掉上一个会话攒的浮标
  if (prev.channelId !== next.channelId) return { anchor: false, follow: true, badge: 0, resetBadge: true }
  const grew = next.count > prev.count
  const firstChanged = next.firstKey !== prev.firstKey
  const lastChanged = next.lastKey !== prev.lastKey
  // 变长且头部换了 = 顶部插了内容（只有「加载更早」会这样；与尾部是否同时有新消息无关）
  const anchor = grew && firstChanged
  // 尾部来了新消息（grew），或条数没变但最后一条换了 key（乐观气泡被网关回执原地认领），或列表被收紧
  const tailChanged = lastChanged || next.count < prev.count
  const follow = !anchor && atBottom && tailChanged
  // 用户正在往上翻：绝不把他拽回底部，只累计浮标数字。
  // 如实说明：这里用「条数增量」近似尾部新增条数 —— 两头同时变化时会略微偏大（把顶部插入的那几条也算进去），
  // 因为签名只带首尾 key、拿不到精确的分侧条数。宁可数字偏大也不丢提示，且点一下浮标就会清零。
  const badge = !atBottom && grew && lastChanged ? next.count - prev.count : 0
  return { anchor, follow, badge, resetBadge: false }
}

export function useDmMessageScroll(sig: DmMessageSignature): DmScrollController {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 默认 true：新打开的会话就该跟着最新一条，不能默认「用户在翻历史」 */
  const atBottomRef = useRef(true)
  const [newCount, setNewCount] = useState(0)
  const newCountRef = useRef(0)
  newCountRef.current = newCount
  const prevSigRef = useRef<DmMessageSignature>({ channelId: '', count: 0, firstKey: '', lastKey: '' })
  /** 上一次「用户实际看到的」滚动几何：加载更早时用它把视图锚回原处（layout effect 里 DOM 已经变了，拿不到旧值） */
  const metricsRef = useRef({ height: 0, top: 0 })

  const scrollToBottom = useCallback((smooth?: boolean): void => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = true
    const top = el.scrollHeight - el.clientHeight
    if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'smooth' })
    else el.scrollTop = top
    metricsRef.current = { height: el.scrollHeight, top: el.scrollTop }
    if (newCountRef.current > 0) setNewCount(0)
  }, [])

  useIsoLayoutEffect(() => {
    const prev = prevSigRef.current
    prevSigRef.current = sig
    const el = scrollRef.current
    if (!el) return
    const plan = decideScrollPlan(prev, sig, atBottomRef.current)
    if (plan.resetBadge) atBottomRef.current = true
    if (plan.anchor) {
      // 「加载更早」：列表变长全部（或主要是）发生在顶部，把 scrollTop 补上这段高度增量
      // = 用户原来看的那条留在原位，既不跳回底部也不跳飞
      const delta = el.scrollHeight - metricsRef.current.height
      el.scrollTop = Math.max(0, metricsRef.current.top + delta)
    } else if (plan.follow) {
      scrollToBottom(false)
    }
    if (plan.badge > 0) setNewCount((n) => n + plan.badge)
    if (plan.resetBadge && newCountRef.current > 0) setNewCount(0)
    metricsRef.current = { height: el.scrollHeight, top: el.scrollTop }
    // 依赖里只有四个原始值：签名不变（面板因别的原因重渲染）时这个 effect 根本不跑
  }, [sig.channelId, sig.count, sig.firstKey, sig.lastKey, scrollToBottom])

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = distanceToBottom(el) <= NEAR_BOTTOM_PX
    metricsRef.current = { height: el.scrollHeight, top: el.scrollTop }
    // 用户自己滚回底部 → 浮标没意义了，清掉；这里用 newCountRef 挡住「每次滚动都 setState」
    if (atBottomRef.current && newCountRef.current > 0) setNewCount(0)
  }, [])

  return { scrollRef, newCount, atBottomRef, scrollToBottom, handleScroll }
}
