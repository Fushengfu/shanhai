import { useState } from 'react'
import { IconChevronDown } from './icons'

/** 「思考过程」折叠区块（紧凑版：无边框、无灰底卡片，左侧细线 + 折叠文字） */
export function ReasoningBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(!!streaming)
  return (
    <div style={{ marginBottom: 6 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', lineHeight: 1.5 }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--text-muted)', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}>
          <IconChevronDown />
        </span>
        {streaming ? '正在思考…' : '思考过程'}
      </button>
      {open && (
        <div style={{ marginTop: 2, paddingLeft: 10, borderLeft: '2px solid var(--border)', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflowY: 'auto' }}>
          {content}
          {streaming && <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>}
        </div>
      )}
    </div>
  )
}
