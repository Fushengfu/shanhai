import * as React from 'react'
import { useState } from 'react'
import type { AskRequest } from '../types'
import { IconMonitor } from './icons'
import { btn } from './ui'

interface SessionPickerProps {
  req: AskRequest
  onSubmit: (answer: string) => void
  onCancel: () => void
}

/** 上下文占用占比 → 人类可读百分比 */
function ratioPct(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  return `${Math.round(ratio * 100)}%`
}

/**
 * 会话选择器（choose_session 工具专用）：渲染会话列表卡片，每项显示标题 + busy/active 状态徽标 + 模型名 + 上下文占用。
 * 单选，选中后把会话 id 回传给 agent；取消走 onCancel。
 */
export function SessionPicker({ req, onSubmit, onCancel }: SessionPickerProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const options = req.sessionOptions ?? []
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
        <IconMonitor />
        请选择会话
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
              {/* 单选圆点 */}
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
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, overflowWrap: 'break-word', wordBreak: 'break-word' }}>{opt.title}</span>
                  {opt.active && (
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--accent)', color: '#fff', flexShrink: 0 }}>当前</span>
                  )}
                  {opt.busy && (
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--tint-red)', color: 'var(--tint-red-strong)', flexShrink: 0 }}>执行中</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {opt.modelName && <span>模型：{opt.modelName}</span>}
                  <span>上下文占用：{ratioPct(opt.contextUsageRatio)}</span>
                  {opt.currentRequest && (
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>需求：{opt.currentRequest}</span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {options.length === 0 && <div style={{ color: 'var(--text-muted)', padding: 8 }}>暂无可选择的会话</div>}
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
