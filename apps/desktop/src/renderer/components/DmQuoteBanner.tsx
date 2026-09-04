import * as React from 'react'
import { IconClose } from './icons'
import type { DmQuotePayload } from '../types'

/**
 * 私信「引用到会话」的来源提示条（渲染在输入框上方）。
 *
 * 为什么需要它：私信原文由用户显式点击「引用到会话」后**追加进输入框**，
 * 一旦进了输入框就和用户自己打的字完全同构，事后无法区分来源。
 * 因此来源信息（谁发的、msgId、时间）单独用这条提示条承载，
 * 而不是拼进正文（拼进正文会被 resendMessage / editResend 当作真实用户指令重放进模型上下文），
 * 也不给消息流 ChatItem 加 source 字段（同理，且会污染历史持久化结构）。
 *
 * 【安全红线】本组件纯展示：不发送、不触发执行、不影响审批，只能被用户手动关闭。
 */
export interface DmQuoteBannerProps {
  quote: DmQuotePayload
  onDismiss: () => void
}

function fmtQuoteTime(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

export function DmQuoteBanner(p: DmQuoteBannerProps): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        marginBottom: 6,
        borderRadius: 8,
        border: '1px solid var(--border-soft)',
        // 用中性底色 + 左侧强调条：明确表达「这是被引用的外部内容」，不是本地用户已发送的话
        background: 'var(--bg-sidebar)',
        borderLeft: '3px solid var(--accent)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        lineHeight: 1.6,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        已把私信原文追加到输入框 · 来自 <b style={{ color: 'var(--text)' }}>{p.quote.fromName}</b>
        <span style={{ opacity: 0.75 }}>（会员 id {p.quote.fromMemberId} · {fmtQuoteTime(p.quote.ts)}）</span>
        <span style={{ opacity: 0.75 }}> · 山海不会自动发送，请你确认后自行发送</span>
      </span>
      <button
        onClick={p.onDismiss}
        title="关闭这条来源提示（不会撤销已追加到输入框的文字）"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: 5,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <IconClose />
      </button>
    </div>
  )
}
