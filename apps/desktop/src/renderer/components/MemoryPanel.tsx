import { useCallback, useEffect, useState } from 'react'
import type { MemoryEntry } from '../types'
import { IconClock, IconTrash } from './icons'
import { formatRelativeTime, smallIconBtn } from './ui'
import { WindowTitleBar } from './WindowTitleBar'

const SCOPE_LABEL: Record<string, string> = {
  user_preference: '用户偏好',
  environment: '环境',
  project_knowledge: '项目知识',
  data_cognition: '数据认知',
  task_experience: '任务经验',
  session: '会话',
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

/** 长期记忆面板：展示跨会话记忆（配置型全量 + 经验型召回），支持删除。侧滑铺满主区域（从侧边栏右缘到窗口右缘、状态栏下方到底部） */
export function MemoryPanel({ left, top, onClose, variant = 'panel' }: { left?: number; top?: number; onClose?: () => void; variant?: 'panel' | 'window' }) {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [hoverId, setHoverId] = useState<number | null>(null)
  const load = useCallback(() => {
    void window.shanhai?.listMemory().then((m) => setMemories(m ?? [])).catch(() => undefined)
  }, [])
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
        title="长期记忆"
        subtitle="跨会话沉淀的偏好与经验"
        extra={
          <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 600, color: 'var(--purple)', background: 'var(--tint-purple)', padding: '2px 9px', borderRadius: 10, flexShrink: 0 }}>
            {memories.length} 条
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
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>暂无长期记忆</div>
              <div style={{ marginTop: 4 }}>对话中可说「记住我偏好…」，AI 会用 remember 工具保存</div>
            </div>
          ) : (
            memories.map((m) => {
              const color = SCOPE_COLOR[m.scope] ?? { dot: 'var(--text-muted)', tint: 'var(--bg-subtle)' }
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
                    {SCOPE_LABEL[m.scope] ?? m.scope}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 3, wordBreak: 'break-word' }}>{m.key}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
                      {typeof m.value === 'string' ? m.value : JSON.stringify(m.value)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 11, color: 'var(--text-faint)' }}>
                      <span>{formatRelativeTime(m.timestamp)}</span>
                      {m.source ? <span>来源 · {m.source}</span> : null}
                      {typeof m.confidence === 'number' ? <span>置信度 · {Math.round(m.confidence * 100)}%</span> : null}
                    </div>
                  </div>
                  <button
                    onClick={() => void remove(m.id)}
                    title="删除"
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
