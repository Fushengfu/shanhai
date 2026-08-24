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
 * 有选项时额外提供「其他（自定义填写）」入口：选项都不符合时，用户可自由输入自定义内容。
 */
export function AskCard({ req, onSubmit, onCancel }: AskCardProps) {
  const hasOptions = (req.options?.length ?? 0) > 0
  const multiple = req.multiple === true
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState('')
  /** 选项列表中的「其他（自定义填写）」是否被选中（选中后显示自由文本输入框） */
  const [customMode, setCustomMode] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 输入法组合中标记：中文等 IME 用回车选词时不应触发提交 */
  const isComposingRef = useRef(false)

  // 自由输入时自动聚焦（无选项，或切换到「自定义填写」）
  useEffect(() => {
    if (!hasOptions || customMode) inputRef.current?.focus()
  }, [hasOptions, customMode])

  const toggle = (opt: string): void => {
    setSelected((prev) => {
      if (multiple) return prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]
      return prev[0] === opt ? [] : [opt]
    })
  }

  const enterCustom = (): void => {
    setCustomMode(true)
    setSelected([])
  }

  const canSubmit = customMode ? text.trim().length > 0 : hasOptions ? selected.length > 0 : text.trim().length > 0

  const submit = (): void => {
    if (!canSubmit) return
    const answer = customMode ? text.trim() : hasOptions ? selected.join('、') : text.trim()
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
        border: '1px solid var(--accent)',
        background: 'var(--tint-blue-soft)',
        fontSize: 13,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        zIndex: 10,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)', display: 'flex', alignItems: 'center' }}>
        <IconHelp />
        AI 需要你的确认
      </div>
      <div style={{ color: 'var(--text)', marginBottom: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        {req.question}
      </div>

      {hasOptions && !customMode ? (
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
                  color: active ? 'var(--accent)' : 'var(--text)',
                  background: active ? 'var(--tint-blue)' : 'var(--bg-panel)',
                  border: active ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
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
                      border: active ? '1px solid var(--accent)' : '1px solid var(--border-heavy)',
                      background: active ? 'var(--accent)' : 'var(--bg-panel)',
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
                      border: active ? '5px solid var(--accent)' : '1px solid var(--border-heavy)',
                      background: 'var(--bg-panel)',
                      boxSizing: 'border-box',
                      flexShrink: 0,
                    }}
                  />
                )}
                <span style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>{opt}</span>
              </div>
            )
          })}
          {multiple && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>可多选，已选 {selected.length} 项</div>}
          {/* 选项都不符合时：切换到自定义填写 */}
          <div
            onClick={enterCustom}
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--text-secondary)',
              background: 'var(--bg-panel)',
              border: '1px dashed var(--border-heavy)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ width: 16, height: 16, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>＋</span>
            其他（自定义填写）
          </div>
        </div>
      ) : (
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => {
            isComposingRef.current = true
          }}
          onCompositionEnd={() => {
            // macOS 原生输入法选词时 compositionend 先于 keydown 触发，延迟清除避免选词回车误提交
            setTimeout(() => {
              isComposingRef.current = false
            }, 0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isComposingRef.current && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={req.placeholder ?? '请输入你的回答'}
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--border-strong)',
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box',
            background: 'var(--bg-panel)',
            color: 'var(--text)',
          }}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {hasOptions && customMode && (
          <button
            onClick={() => {
              setCustomMode(false)
              setText('')
            }}
            style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}
          >
            返回选项
          </button>
        )}
        <button onClick={submit} disabled={!canSubmit} style={{ ...btn('var(--accent)', '#fff'), opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
          提交
        </button>
        <button onClick={onCancel} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
          取消
        </button>
      </div>
    </div>
  )
}
