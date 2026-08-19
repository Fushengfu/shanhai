import { useState } from 'react'
import { IconChevronDown } from './icons'

/** 「思考过程」折叠区块（参考 DSH / DeepSeek：灰底、可折叠，与正式回答区分） */
export function ReasoningBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(!!streaming)
  return (
    <div style={{ marginBottom: 8, maxWidth: '85%' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, border: '1px solid #eee', background: '#f7f7f8', color: '#888', fontSize: 12, cursor: 'pointer' }}
      >
        <span style={{ display: 'inline-flex', color: '#999', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}>
          <IconChevronDown />
        </span>
        {streaming ? '正在思考…' : '思考过程'}
      </button>
      {open && (
        <div style={{ marginTop: 4, padding: '8px 12px', borderRadius: 8, background: '#f7f7f8', color: '#888', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflowY: 'auto' }}>
          {content}
          {streaming && <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>}
        </div>
      )}
    </div>
  )
}
