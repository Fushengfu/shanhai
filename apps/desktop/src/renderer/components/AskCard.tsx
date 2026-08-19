import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AskRequest } from '../types'
import { IconHelp } from './icons'
import { btn } from './ui'

interface AskCardProps {
  req: AskRequest
  onSubmit: (answer: string) => void
  onCancel: () => void
}

/**
 * AI 向用户提问卡片（输入框上方浮动）。
 * 交互式：有 options 渲染单选/多选，无 options 渲染自由文本输入，提交后把答案回传给 agent。
 */
export function AskCard({ req, onSubmit, onCancel }: AskCardProps) {
  const hasOptions = (req.options?.length ?? 0) > 0
  const multiple = req.multiple === true
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 自由输入时自动聚焦（单选/多选无需输入）
  useEffect(() => {
    if (!hasOptions) inputRef.current?.focus()
  }, [hasOptions])

  const toggle = (opt: string): void => {
    setSelected((prev) => {
      if (multiple) return prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]
      return prev[0] === opt ? [] : [opt]
    })
  }

  const canSubmit = hasOptions ? selected.length > 0 : text.trim().length > 0

  const submit = (): void => {
    if (!canSubmit) return
    const answer = hasOptions ? selected.join('、') : text.trim()
    onSubmit(answer)
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 158,
        left: 16,
        right: 16,
        padding: 14,
        borderRadius: 12,
        border: '1px solid #1677ff',
        background: '#f0f7ff',
        fontSize: 13,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        zIndex: 10,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: '#333', display: 'flex', alignItems: 'center' }}>
        <IconHelp />
        AI 需要你的确认
      </div>
      <div style={{ color: '#333', marginBottom: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        {req.question}
      </div>

      {hasOptions ? (
        <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(req.options ?? []).map((opt) => {
            const active = selected.includes(opt)
            return (
              <div
                key={opt}
                onClick={() => toggle(opt)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: active ? '#1677ff' : '#333',
                  background: active ? '#e6f4ff' : '#fff',
                  border: active ? '1px solid #1677ff' : '1px solid #e0e0e0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {/* 单选圆点 / 多选方框 */}
                {multiple ? (
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      border: active ? '1px solid #1677ff' : '1px solid #bbb',
                      background: active ? '#1677ff' : '#fff',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontSize: 12,
                      flexShrink: 0,
                    }}
                  >
                    {active && '✓'}
                  </span>
                ) : (
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: '50%',
                      border: active ? '5px solid #1677ff' : '1px solid #bbb',
                      background: '#fff',
                      boxSizing: 'border-box',
                      flexShrink: 0,
                    }}
                  />
                )}
                <span style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>{opt}</span>
              </div>
            )
          })}
          {multiple && <div style={{ fontSize: 11, color: '#999' }}>可多选，已选 {selected.length} 项</div>}
        </div>
      ) : (
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={req.placeholder ?? '请输入你的回答'}
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid #d9d9d9',
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box',
            background: '#fff',
            color: '#333',
          }}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={submit} disabled={!canSubmit} style={{ ...btn('#1677ff', '#fff'), opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
          提交
        </button>
        <button onClick={onCancel} style={btn('#fff', '#333', '1px solid #ddd')}>
          取消
        </button>
      </div>
    </div>
  )
}
