import { useState } from 'react'
import { IconEdit, IconTrash } from './icons'
import { formatRelativeTime } from './ui'

/** 会话列表行：现代卡片式（圆角 + 标题/副标题两行 + 活跃高亮 + hover 显示操作） */
export function SessionRow(props: {
  session: { id: string; title: string; workDir: string; lastActiveAt?: number }
  active: boolean
  busy: boolean
  editing: boolean
  editingTitle: string
  onTitleChange: (v: string) => void
  onStartEdit: () => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onDelete: () => void
  onSelect: () => void
}) {
  const { session: s } = props
  const [hovered, setHovered] = useState(false)

  if (props.editing) {
    return (
      <div
        style={{
          margin: '0 8px 2px',
          padding: '6px 10px',
          borderRadius: 8,
          background: 'var(--tint-blue)',
        }}
      >
        <input
          value={props.editingTitle}
          onChange={(e) => props.onTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onCommitEdit()
            if (e.key === 'Escape') props.onCancelEdit()
          }}
          autoFocus
          onBlur={props.onCommitEdit}
          style={{
            width: '100%',
            padding: '5px 8px',
            borderRadius: 6,
            border: '1px solid var(--accent)',
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box',
            background: 'var(--bg-panel)',
            color: 'var(--text)',
          }}
        />
      </div>
    )
  }

  // 副标题：执行中显示「处理中」（活跃时间即当前时间，无需显示时间）；空闲后显示最后活跃时间；不再显示工作目录
  const relTime = s.lastActiveAt ? formatRelativeTime(s.lastActiveAt) : ''
  const subtitle = props.busy ? '处理中' : relTime

  return (
    <div
      onClick={props.onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        margin: '0 8px 2px',
        padding: '8px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        background: props.active ? 'var(--tint-blue)' : hovered ? 'var(--bg-hover)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        transition: 'background 0.12s ease',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          title={s.title}
          style={{
            fontSize: 13,
            lineHeight: '18px',
            fontWeight: props.active ? 600 : 400,
            color: props.active ? 'var(--accent)' : 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {s.title}
        </div>
        {subtitle && (
          <div
            title={subtitle}
            style={{
              fontSize: 11,
              lineHeight: '15px',
              color: props.busy ? 'var(--accent)' : 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 1,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {props.busy && (
        <span
          title="任务执行中"
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '2px solid var(--tint-blue)',
            borderTopColor: 'var(--accent)',
            flexShrink: 0,
            animation: 'spin 0.8s linear infinite',
          }}
        />
      )}
      {hovered && (
        <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              props.onStartEdit()
            }}
            title="重命名"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: 4,
              borderRadius: 5,
              display: 'inline-flex',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-panel)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <IconEdit />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              props.onDelete()
            }}
            title="删除会话"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: 4,
              borderRadius: 5,
              display: 'inline-flex',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-panel)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <IconTrash />
          </button>
        </span>
      )}
    </div>
  )
}
