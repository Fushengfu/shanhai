import * as React from 'react'
import { useState } from 'react'
import type { AskRequest } from '../types'
import { IconWrench } from './icons'
import { btn } from './ui'

interface ModelPickerProps {
  req: AskRequest
  onSubmit: (answer: string) => void
  onCancel: () => void
}

/**
 * 模型选择器（choose_model 工具专用）：渲染模型列表，单选，选中后把模型 id 回传给 agent；取消走 onCancel。
 */
export function ModelPicker({ req, onSubmit, onCancel }: ModelPickerProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const options = req.modelOptions ?? []
  const canSubmit = selected != null

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 158,
        left: 16,
        right: 16,
        padding: 14,
        borderRadius: 12,
        border: '1px solid var(--accent)',
        background: 'var(--tint-blue-soft)',
        fontSize: 13,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        zIndex: 10,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)', display: 'flex', alignItems: 'center' }}>
        <IconWrench />
        请选择模型
      </div>
      <div style={{ color: 'var(--text)', marginBottom: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        {req.question}
      </div>

      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {options.map((opt) => {
          const active = selected === opt.id
          return (
            <div
              key={opt.id}
              onClick={() => setSelected(opt.id)}
              style={{
                padding: '9px 10px',
                borderRadius: 8,
                cursor: 'pointer',
                color: 'var(--text)',
                background: active ? 'var(--tint-blue)' : 'var(--bg-panel)',
                border: active ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  border: active ? '5px solid var(--accent)' : '1px solid var(--border-heavy)',
                  background: 'var(--bg-panel)',
                  boxSizing: 'border-box',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontWeight: 600, overflowWrap: 'break-word', wordBreak: 'break-word' }}>{opt.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{opt.id}</span>
            </div>
          )
        })}
        {options.length === 0 && <div style={{ color: 'var(--text-muted)', padding: 8 }}>暂无可选择的模型</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={() => selected && onSubmit(selected)} disabled={!canSubmit} style={{ ...btn('var(--accent)', '#fff'), opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
          选择
        </button>
        <button onClick={onCancel} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
          取消
        </button>
      </div>
    </div>
  )
}
