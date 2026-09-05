import { memo, useState } from 'react'
import { IconClock, IconCopy, IconEdit, IconRefresh } from './icons'
import { MessageActions } from './MessageActions'
import { copyText } from './ui'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

/** 用户消息气泡：右对齐，气泡下方常显「编辑 / 复制 / 重新发送」；编辑为内联编辑（Enter 确认 / Esc 取消，参考 taco） */
export const UserMessage = memo(function UserMessage({ content, images, userIndex, busy, pending, onResend, onEditResend, onPreviewImage }: {
  content: string
  images?: string[]
  userIndex: number
  busy: boolean
  /** 排队中标记：任务执行中提交的消息，尚未开始执行，显示「排队中」标签且不可编辑/重发 */
  pending?: boolean
  onResend: (userIndex: number) => void
  onEditResend: (userIndex: number, newContent: string) => void
  onPreviewImage: (url: string) => void
}) {
  // 【期4C 重扫补修】本组件是 memo，父重渲染不会带着它 → 语言变化必须自己订阅
  useLocaleSync()
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
          alt={t('chat.user.attachmentAlt')}
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
            style={{ width: '100%', padding: '8px 14px', borderRadius: 12, border: '1px solid var(--accent)', fontSize: 14, lineHeight: 1.6, resize: 'none', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', background: 'var(--bg-panel)', color: 'var(--text)', display: 'block' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            <span>{t('chat.user.editHint')}</span>
            <button onClick={confirmEdit} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: 'pointer' }}>{t('chat.user.confirm')}</button>
            <button onClick={() => { setEditing(false); setDraft(content) }} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : content ? (
        <>
          <div style={{ maxWidth: '70%', minWidth: 0, padding: '8px 14px', borderRadius: 16, borderBottomRightRadius: 4, background: 'var(--accent)', color: '#fff', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', opacity: pending ? 0.65 : 1, userSelect: 'text', WebkitUserSelect: 'text' }}>
            {content}
          </div>
          {pending ? (
            <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              <IconClock /> {t('chat.user.queued')}
            </div>
          ) : !busy ? (
            <MessageActions
              actions={[
                { key: 'edit', icon: <IconEdit />, label: t('chat.user.edit'), run: () => { setEditing(true); setDraft(content) } },
                { key: 'copy', icon: <IconCopy />, label: t('common.copy'), run: () => copyText(content) },
                { key: 'resend', icon: <IconRefresh />, label: t('chat.user.resend'), run: () => onResend(userIndex) },
              ]}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
})
