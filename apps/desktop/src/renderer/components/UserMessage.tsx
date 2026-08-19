import { useState } from 'react'
import { IconCopy, IconEdit, IconRefresh } from './icons'
import { MessageActions } from './MessageActions'
import { copyText } from './ui'

/** 用户消息气泡：右对齐，气泡下方常显「编辑 / 复制 / 重新发送」；编辑为内联编辑（Enter 确认 / Esc 取消，参考 taco） */
export function UserMessage({ content, images, userIndex, busy, onResend, onEditResend, onPreviewImage }: {
  content: string
  images?: string[]
  userIndex: number
  busy: boolean
  onResend: (userIndex: number) => void
  onEditResend: (userIndex: number, newContent: string) => void
  onPreviewImage: (url: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)

  const confirmEdit = (): void => {
    const text = draft.trim()
    setEditing(false)
    if (text && text !== content) onEditResend(userIndex, text)
  }

  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      {images?.map((img, j) => (
        <img
          key={j}
          src={img}
          alt="附件"
          onClick={() => onPreviewImage(img)}
          style={{ maxWidth: 200, maxHeight: 200, borderRadius: 8, display: 'block', marginBottom: 4, objectFit: 'cover', cursor: 'zoom-in' }}
        />
      ))}
      {editing ? (
        <div style={{ width: '100%', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                confirmEdit()
              } else if (e.key === 'Escape') {
                setEditing(false)
                setDraft(content)
              }
            }}
            autoFocus
            rows={3}
            style={{ width: '100%', padding: '8px 14px', borderRadius: 12, border: '1px solid #1677ff', fontSize: 14, lineHeight: 1.6, resize: 'none', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', background: '#fff', color: '#333', display: 'block' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#999' }}>
            <span>Enter 确认 · Esc 取消</span>
            <button onClick={confirmEdit} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: '#1677ff', color: '#fff', fontSize: 12, cursor: 'pointer' }}>确认</button>
            <button onClick={() => { setEditing(false); setDraft(content) }} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 12, cursor: 'pointer' }}>取消</button>
          </div>
        </div>
      ) : content ? (
        <>
          <div style={{ maxWidth: '70%', padding: '8px 14px', borderRadius: 16, borderBottomRightRadius: 4, background: '#1677ff', color: '#fff', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            {content}
          </div>
          {!busy && (
            <MessageActions
              actions={[
                { key: 'edit', icon: <IconEdit />, label: '编辑', run: () => { setEditing(true); setDraft(content) } },
                { key: 'copy', icon: <IconCopy />, label: '复制', run: () => copyText(content) },
                { key: 'resend', icon: <IconRefresh />, label: '重新发送', run: () => onResend(userIndex) },
              ]}
            />
          )}
        </>
      ) : null}
    </div>
  )
}
