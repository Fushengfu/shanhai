import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconClose } from './icons'
import './dm-toast.css'

/**
 * 【P6】私信面板的轻量浮层 toast：底部居中、自动消失、可点 × 关闭、明暗自适应。
 *
 * 与顶部常驻音条（notice / errorText，任务59「防闪」成果，容器恒定占一行只切透明度）明确分工：
 *  - 常驻音条：管「通道级常驻状态」（未登录 / 凭证三态 / 连接中 / 已发送之类长时间存在的信息）；
 *  - 本组件：管「即时轻量反馈」（发送成功 / 发送失败 / 子项已复制之类，几秒就该消失的），
 *    不抢占主交互，自动消失。
 * 不要把它改回"条件渲染进主列"：那会把下方列表顶下去再弹回来，正是任务59 修的闪烁。
 */

export interface DmToastState {
  id: number
  type: 'info' | 'error' | 'success'
  text: string
  durationMs: number
}

export interface UseDmToastResult {
  toast: DmToastState | null
  show: (t: { type?: DmToastState['type']; text: string; durationMs?: number }) => void
  dismiss: () => void
}

let toastSeq = 0

/** 【P6】轻量 toast 状态管理：单条（新的会顶掉旧的），默认 3000ms 自动消失。 */
export function useDmToast(): UseDmToastResult {
  const [toast, setToast] = useState<DmToastState | null>(null)
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dismiss = useCallback(() => {
    if (hideRef.current) clearTimeout(hideRef.current)
    setToast(null)
  }, [])

  const show = useCallback((t: { type?: DmToastState['type']; text: string; durationMs?: number }): void => {
    const id = (toastSeq += 1)
    const state: DmToastState = { id, type: t.type ?? 'info', text: t.text, durationMs: t.durationMs ?? 3000 }
    setToast(state)
    if (hideRef.current) clearTimeout(hideRef.current)
    hideRef.current = setTimeout(() => setToast(null), state.durationMs)
  }, [])

  useEffect(() => {
    return () => {
      if (hideRef.current) clearTimeout(hideRef.current)
    }
  }, [])

  return { toast, show, dismiss }
}

export function DmToast(props: { toast: DmToastState | null; onDismiss: () => void }): React.JSX.Element | null {
  const t = props.toast
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (t) {
      // 下一帧再置为可见，触发进入动画
      const raf = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(raf)
    }
    setVisible(false)
    return undefined
  }, [t])
  if (!t) return null
  return (
    <div className={`dm-toast dm-toast-${t.type} ${visible ? 'dm-toast-in' : ''}`} role="status">
      <span className="dm-toast-text">{t.text}</span>
      <button className="dm-toast-close" onClick={props.onDismiss} aria-label="close">
        <IconClose />
      </button>
    </div>
  )
}
