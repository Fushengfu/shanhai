import { useState } from 'react'
import { IconEdit, IconTrash } from './icons'

export function SessionRow(props: {
  session: { id: string; title: string; workDir: string }
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
  const [hover, setHover] = useState(false)
  const { session: s } = props

  if (props.editing) {
    return (
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #eee', background: props.active ? '#e8f1ff' : 'transparent' }}>
        <input
          value={props.editingTitle}
          onChange={(e) => props.onTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onCommitEdit()
            if (e.key === 'Escape') props.onCancelEdit()
          }}
          autoFocus
          onBlur={props.onCommitEdit}
          style={{ width: '100%', padding: '4px 6px', borderRadius: 6, border: '1px solid #1677ff', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
        />
      </div>
    )
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={props.onSelect}
      style={{
        padding: '8px 12px',
        cursor: 'pointer',
        fontSize: 13,
        color: '#333',
        borderBottom: '1px solid #eee',
        background: props.active ? '#e8f1ff' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={s.title}>
        {s.title}
      </span>
      {props.busy && (
        <span
          title="任务执行中"
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '2px solid #d9e8ff',
            borderTopColor: '#1677ff',
            flexShrink: 0,
            animation: 'spin 0.8s linear infinite',
          }}
        />
      )}
      {(hover || props.active) && (
        <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              props.onStartEdit()
            }}
            title="重命名"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 2, display: 'inline-flex' }}
          >
            <IconEdit />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              props.onDelete()
            }}
            title="删除会话"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 2, display: 'inline-flex' }}
          >
            <IconTrash />
          </button>
        </span>
      )}
    </div>
  )
}
