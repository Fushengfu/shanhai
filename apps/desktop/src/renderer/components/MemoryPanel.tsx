import { useCallback, useEffect, useState } from 'react'
import type { MemoryEntry } from '../types'
import { useUiStore } from '../store-client'
import { IconClock, IconTrash } from './icons'
import { formatRelativeTime, smallIconBtn } from './ui'
import { WindowTitleBar } from './WindowTitleBar'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

// 【i18n 期4C】表里存词条 key 不存中文（第 7 次同一个坑：模块级常量在加载期固化）
const SCOPE_LABEL_KEY: Record<string, string> = {
  user_preference: 'panels.scopeUserPreference',
  environment: 'panels.scopeEnvironment',
  project_knowledge: 'panels.scopeProjectKnowledge',
  data_cognition: 'panels.scopeDataCognition',
  task_experience: 'panels.scopeTaskExperience',
  session: 'panels.scopeSession',
}

/** scope → 标签配色（圆点 + 浅色底），按类型区分更直观 */
const SCOPE_COLOR: Record<string, { dot: string; tint: string }> = {
  user_preference: { dot: 'var(--purple)', tint: 'var(--tint-purple)' },
  environment: { dot: 'var(--accent)', tint: 'var(--tint-blue-soft)' },
  project_knowledge: { dot: 'var(--success)', tint: 'var(--tint-green)' },
  data_cognition: { dot: 'var(--warning)', tint: 'var(--tint-orange)' },
  task_experience: { dot: 'var(--danger)', tint: 'var(--tint-red)' },
  session: { dot: 'var(--text-muted)', tint: 'var(--bg-subtle)' },
}

/** 长期记忆面板：展示当前会话记忆（按会话隔离），支持删除。侧滑铺满主区域（从侧边栏右缘到窗口右缘、状态栏下方到底部） */
export function MemoryPanel({ left, top, onClose, variant = 'panel' }: { left?: number; top?: number; onClose?: () => void; variant?: 'panel' | 'window' }) {
  // 【期4C 谁取词谁订阅】本组件渲染期取词（标题/空态/scope 标签）→ 必须自订阅
  useLocaleSync()
  const currentSessionId = useUiStore().currentSessionId
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [hoverId, setHoverId] = useState<number | null>(null)
  const load = useCallback(() => {
    void window.shanhai?.listMemory(currentSessionId ?? '').then((m) => setMemories(m ?? [])).catch(() => undefined)
  }, [currentSessionId])
  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async (id: number): Promise<void> => {
    await window.shanhai?.removeMemory(id)
    load()
  }

  return (
    <div
      style={{
        ...(variant === 'window'
          ? { height: '100vh' }
          : { position: 'fixed', top, left, right: 0, bottom: 0, zIndex: 50, borderLeft: '1px solid var(--border)', boxShadow: '-20px 0 60px rgba(0,0,0,0.2)' }),
        background: 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* 头部：统一窗口标题栏（可拖动 + 自定义关闭） */}
      <WindowTitleBar
        icon={<IconClock />}
        tone="purple"
        title={t('panels.memoryTitle')}
        subtitle={t('panels.memorySubtitle')}
        extra={
          <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 600, color: 'var(--purple)', background: 'var(--tint-purple)', padding: '2px 9px', borderRadius: 10, flexShrink: 0 }}>
            {t('panels.memoryCount', { n: memories.length })}
          </span>
        }
        onClose={() => onClose?.()}
      />

        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          {memories.length === 0 ? (
            <div style={{ padding: '56px 0', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, lineHeight: 1.7 }}>
              <span style={{ display: 'inline-flex', width: 48, height: 48, borderRadius: '50%', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-subtle)', color: 'var(--text-faint)', marginBottom: 12 }}>
                <IconClock />
              </span>
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>{t('panels.memoryEmpty')}</div>
              <div style={{ marginTop: 4 }}>{t('panels.memoryEmptyHint')}</div>
            </div>
          ) : (
            memories.map((m) => {
              const color = SCOPE_COLOR[m.scope] ?? { dot: 'var(--text-muted)', tint: 'var(--bg-subtle)' }
              // 期4C：先取 key 再判空（TS 不会穿透三元收窄索引访问），语义与改前 `SCOPE_LABEL[m.scope] ?? m.scope` 一致
              const scopeKey = SCOPE_LABEL_KEY[m.scope]
              const isHover = hoverId === m.id
              return (
                <div
                  key={m.id}
                  onMouseEnter={() => setHoverId(m.id)}
                  onMouseLeave={() => setHoverId((cur) => (cur === m.id ? null : cur))}
                  style={{
                    marginBottom: 8,
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: isHover ? '1px solid var(--border-strong)' : '1px solid var(--border-soft)',
                    background: 'var(--bg-sidebar)',
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                    transition: 'border-color 0.15s ease',
                  }}
                >
                  {/* scope 标签：彩色圆点 + 文字 */}
                  <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', padding: '3px 9px', borderRadius: 8, background: color.tint, marginTop: 0 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: color.dot, flexShrink: 0 }} />
                    {scopeKey ? t(scopeKey) : m.scope}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 3, wordBreak: 'break-word' }}>{m.key}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
                      {typeof m.value === 'string' ? m.value : JSON.stringify(m.value)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 11, color: 'var(--text-faint)' }}>
                      <span>{formatRelativeTime(m.timestamp)}</span>
                      {m.source ? <span>{t('panels.memorySource', { source: m.source })}</span> : null}
                      {typeof m.confidence === 'number' ? <span>{t('panels.memoryConfidence', { pct: Math.round(m.confidence * 100) })}</span> : null}
                    </div>
                  </div>
                  <button
                    onClick={() => void remove(m.id)}
                    title={t('common.delete')}
                    style={{
                      flexShrink: 0,
                      ...smallIconBtn,
                      color: isHover ? 'var(--danger)' : 'var(--text-faint)',
                      opacity: isHover ? 1 : 0.45,
                      transition: 'opacity 0.15s ease, color 0.15s ease',
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              )
            })
          )}
        </div>
    </div>
  )
}
