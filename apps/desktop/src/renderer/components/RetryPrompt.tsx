import * as React from 'react'
import type { RetryPrompt } from '../types'
import { IconError, IconRefresh } from './icons'
import { btn } from './ui'

interface RetryPromptProps {
  prompt: RetryPrompt
  onRetry: () => void
  onCancel: () => void
}

/**
 * 任务失败重试弹窗（输入框上方浮动）。
 * 可重试错误（网络/余额不足等）自动重试 5 次耗尽后弹出：重试 = 保持上下文续跑，取消 = 任务挂起。
 */
export function RetryPromptCard({ prompt, onRetry, onCancel }: RetryPromptProps) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 158,
        left: 16,
        right: 16,
        padding: 14,
        borderRadius: 12,
        border: '1px solid var(--tint-red-strong)',
        background: 'var(--tint-red)',
        fontSize: 13,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        zIndex: 10,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)', display: 'flex', alignItems: 'center' }}>
        <IconError />
        任务执行失败
      </div>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        已自动重试多次仍未成功，可能原因：网络异常、服务暂时不可用或账户余额/额度不足。
      </div>
      <div
        style={{
          color: 'var(--text-secondary)',
          marginBottom: 10,
          fontSize: 12,
          background: 'var(--bg-panel)',
          borderRadius: 8,
          padding: '8px 10px',
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          maxHeight: 120,
          overflowY: 'auto',
        }}
      >
        {prompt.message}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onRetry} style={btn('var(--accent)', '#fff')}>
          <IconRefresh />
          重试
        </button>
        <button onClick={onCancel} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
          取消
        </button>
      </div>
    </div>
  )
}
