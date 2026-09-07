import * as React from 'react'
import { useState } from 'react'
import type { AskRequest } from '../types'
import { IconWrench } from './icons'
import { btn } from './ui'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

interface ModelPickerProps {
  req: AskRequest
  onSubmit: (answer: string) => void
  onCancel: () => void
}

/**
 * 模型选择器（choose_model 工具专用）：渲染模型列表，单选，选中后把模型 id 回传给 agent；取消走 onCancel。
 */
export function ModelPicker({ req, onSubmit, onCancel }: ModelPickerProps) {
  // 谁取词谁订阅
  useLocaleSync()
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
        // 任务114：卡片整体不得超出视口安全区。外层原本只有 bottom:158 下锚点、无高度上限，
        // 内容（长问题 / 长审批参数）一多就向上撑高，绘制到顶部标题栏之上，盖住最小化/最大化/关闭按钮。
        // 227 = 158（既有下锚点，见上方 bottom）+ 69（标题栏安全区：管家窗口 WindowTitleBar
        // padding 16+16 + 最高子元素 WindowControlButton 36 + borderBottom 1 = 69；会话窗口 HeaderPlugin 同算法=61，取大者）。
        // 用 maxHeight 不用 height：内容少时按内容高，不留白（任务107 那类坑）。
        maxHeight: 'calc(100% - 227px)',
        overflowY: 'auto',
        zIndex: 10,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)', display: 'flex', alignItems: 'center' }}>
        <IconWrench />
        {t('panels.modelPicker.title')}
      </div>
      {/* 任务114：问题正文限高滚动（同 AskCard / SessionPicker 口径） */}
      <div style={{ color: 'var(--text)', marginBottom: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>
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
        {options.length === 0 && <div style={{ color: 'var(--text-muted)', padding: 8 }}>{t('panels.modelPicker.empty')}</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={() => selected && onSubmit(selected)} disabled={!canSubmit} style={{ ...btn('var(--accent)', '#fff'), opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
          {t('panels.modelPicker.confirm')}
        </button>
        <button onClick={onCancel} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}
