import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MemoryEntry, MemoryStatus } from '../types'
import { useUiStore } from '../store-client'
import { IconCheck, IconClock, IconClose, IconEdit, IconSearch, IconTrash, IconWarn } from './icons'
import { btn, formatDateTime, smallIconBtn } from './ui'
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

/** 把任意记忆值渲染成可编辑文本（字符串原样；对象按 JSON 展开，保证保存回去仍是合法内容） */
function toDraftText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 长期记忆面板：展示当前会话记忆（按会话隔离），支持搜索 / 编辑正文 / 删除。
 *  侧滑铺满主区域（从侧边栏右缘到窗口右缘、状态栏下方到底部） */
export function MemoryPanel({ left, top, sessionId, onClose, variant = 'panel' }: {
  left?: number
  top?: number
  /**
   * 【任务220 · 第4条】要展示哪个会话的记忆（可选）。
   * 不传 = 原行为：读 ui-store 的 currentSessionId（独立应用窗口即「当前会话」）。
   * 传 'supervisor' = 展示会话管家自己的记忆——管家面板在窗口内复用它时用这条路径，
   * 因为管家会话不是、也不能是 currentSessionId（runtime 的 switchSessionInternal 明确拒绝）。
   */
  sessionId?: string
  onClose?: () => void
  variant?: 'panel' | 'window'
}) {
  // 【期4C 谁取词谁订阅】本组件渲染期取词（标题/空态/scope 标签）→ 必须自订阅
  useLocaleSync()
  const currentSessionId = sessionId ?? useUiStore().currentSessionId
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [hoverId, setHoverId] = useState<number | null>(null)
  // 【任务257】搜索：纯前端过滤（数据已全量在渲染层），不新增 IPC
  const [query, setQuery] = useState('')
  // 【任务257】编辑：只改正文。editingId = 正在编辑的条目 id，draft = 正文草稿
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  /** 保存失败原因（就地显示在编辑区，禁止静默吞掉） */
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 【任务257】落盘状态：写失败必须在面板上看得见（不吃 console） */
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const load = useCallback(() => {
    void window.shanhai?.listMemory(currentSessionId ?? '').then((m) => setMemories(m ?? [])).catch(() => undefined)
  }, [currentSessionId])
  /** 落盘状态只读拉取（主进程侧不清空）—— 打开时与每次写操作后各拉一次 */
  const refreshStatus = useCallback(() => {
    void window.shanhai?.memoryStatus?.().then((s) => setStatus(s ?? null)).catch(() => undefined)
  }, [])
  useEffect(() => {
    load()
    refreshStatus()
  }, [load, refreshStatus])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async (id: number): Promise<void> => {
    if (editingId === id) setEditingId(null)
    await window.shanhai?.removeMemory(id)
    load()
    refreshStatus()
  }

  /** 进入编辑：只有 value 可编；scope/key/created 保持只读（见下方渲染） */
  const startEdit = (m: MemoryEntry): void => {
    setEditingId(m.id)
    setDraft(toDraftText(m.value))
    setSaveError(null)
  }
  const cancelEdit = (): void => {
    setEditingId(null)
    setDraft('')
    setSaveError(null)
  }
  /** 保存正文：走主进程 memory:update（内核复用 store.save 的写入路径：原子写 + 手改优先归档） */
  const saveEdit = async (id: number): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const r = await window.shanhai?.updateMemory(id, draft)
      if (!r) {
        setSaveError(t('panels.memorySaveFailed', { error: 'bridge_unavailable' }))
      } else if (!r.ok) {
        setSaveError(t('panels.memorySaveFailed', { error: r.error ?? '' }))
      } else {
        setEditingId(null)
        setDraft('')
        load()
      }
    } catch (err) {
      setSaveError(t('panels.memorySaveFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSaving(false)
      refreshStatus()
    }
  }

  // 搜索：key 与正文子串匹配（大小写不敏感）；空输入 = 全部
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!q) return memories
    return memories.filter((m) => {
      const text = typeof m.value === 'string' ? m.value : JSON.stringify(m.value ?? '')
      return m.key.toLowerCase().includes(q) || text.toLowerCase().includes(q)
    })
  }, [memories, q])

  // 写失败横幅：ok=false（当前失败态）或 failures>0（历史上失败过）都如实显示
  const showWriteFail = !!status && (!status.ok || status.failures > 0)
  const writeFailText = status
    ? status.error
      ? t('panels.memoryWriteFailBanner', { n: status.failures, error: status.error })
      : t('panels.memoryWriteFailUnknown', { n: status.failures })
    : ''
  const unknownCount = status?.unknownFiles.length ?? 0

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

        {/* 【任务257】搜索框：样式照抄私信面板左列顶部搜索框（同一套 border/圆角/bg-input/清除按钮） */}
        <div style={{ padding: '10px 14px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-input)' }}>
            <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}><IconSearch /></span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('panels.memorySearchPlaceholder')}
              style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12 }}
            />
            {!!query && (
              <button onClick={() => setQuery('')} title={t('common.clear')} style={{ ...smallIconBtn, width: 18, height: 18 }}>
                <IconClose />
              </button>
            )}
          </div>
          {/* 必须显示命中数（搜索态）；零命中另有空态文案，不留空白列表 */}
          {!!q && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-faint)' }}>
              {t('panels.memorySearchCount', { n: shown.length, total: memories.length })}
            </div>
          )}
        </div>

        {/* 【任务257】写失败可见：不再只进 console，面板上给横幅（写成功即自动消失） */}
        {showWriteFail && (
          <div style={{ margin: '10px 14px 0', flexShrink: 0, display: 'flex', alignItems: 'flex-start', gap: 6, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--tint-red-strong)', background: 'var(--tint-red)', color: 'var(--danger-text)', fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word' }}>
            <span style={{ display: 'inline-flex', flexShrink: 0, marginTop: 1 }}><IconWarn /></span>
            <div>
              <div>{writeFailText}</div>
              {unknownCount > 0 && (
                <div style={{ marginTop: 2, color: 'var(--text-secondary)' }}>
                  {t('panels.memoryUnknownFiles', { n: unknownCount })}
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          {memories.length === 0 ? (
            <div style={{ padding: '56px 0', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, lineHeight: 1.7 }}>
              <span style={{ display: 'inline-flex', width: 48, height: 48, borderRadius: '50%', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-subtle)', color: 'var(--text-faint)', marginBottom: 12 }}>
                <IconClock />
              </span>
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>{t('panels.memoryEmpty')}</div>
              <div style={{ marginTop: 4 }}>{t('panels.memoryEmptyHint')}</div>
            </div>
          ) : shown.length === 0 ? (
            /* 【任务257】零命中必须给明确空态文案（不能是空白列表） */
            <div style={{ padding: '56px 0', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, lineHeight: 1.7 }}>
              <span style={{ display: 'inline-flex', width: 48, height: 48, borderRadius: '50%', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-subtle)', color: 'var(--text-faint)', marginBottom: 12 }}>
                <IconSearch />
              </span>
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>{t('panels.memorySearchEmpty')}</div>
              <div style={{ marginTop: 4 }}>{t('panels.memorySearchEmptyHint')}</div>
            </div>
          ) : (
            shown.map((m) => {
              const color = SCOPE_COLOR[m.scope] ?? { dot: 'var(--text-muted)', tint: 'var(--bg-subtle)' }
              // 期4C：先取 key 再判空（TS 不会穿透三元收窄索引访问），语义与改前 `SCOPE_LABEL[m.scope] ?? m.scope` 一致
              const scopeKey = SCOPE_LABEL_KEY[m.scope]
              const isHover = hoverId === m.id
              const isEditing = editingId === m.id
              const created = m.created ?? m.timestamp
              // created == updated 时不重复显示（两者相差 < 1 分钟视为同一次写入）
              const showUpdated = typeof m.updated === 'number' && Math.abs(m.updated - created) >= 60_000
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
                  {/* scope 标签：彩色圆点 + 文字（只读，不可编辑） */}
                  <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', padding: '3px 9px', borderRadius: 8, background: color.tint, marginTop: 0 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: color.dot, flexShrink: 0 }} />
                    {scopeKey ? t(scopeKey) : m.scope}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* key 只读：改它等于换文件名，属另一件事（不给假入口） */}
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 3, wordBreak: 'break-word' }}>{m.key}</div>
                    {isEditing ? (
                      <div>
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={6}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: '1px solid var(--border)',
                            background: 'var(--bg-input)',
                            color: 'var(--text)',
                            fontSize: 12.5,
                            lineHeight: 1.55,
                            fontFamily: 'inherit',
                            resize: 'vertical',
                            outline: 'none',
                          }}
                        />
                        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-faint)' }}>{t('panels.memoryEditHint')}</div>
                        {saveError && (
                          <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--danger-text)', wordBreak: 'break-word' }}>{saveError}</div>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <button
                            disabled={saving}
                            onClick={() => void saveEdit(m.id)}
                            style={{ ...btn('var(--accent)', '#fff'), display: 'inline-flex', alignItems: 'center', gap: 5, opacity: saving ? 0.6 : 1, cursor: saving ? 'default' : 'pointer' }}
                          >
                            <IconCheck />
                            {saving ? t('common.saving') : t('common.save')}
                          </button>
                          <button
                            disabled={saving}
                            onClick={cancelEdit}
                            style={{ ...btn('var(--bg-input)', 'var(--text-secondary)', '1px solid var(--border)'), opacity: saving ? 0.6 : 1, cursor: saving ? 'default' : 'pointer' }}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
                        {typeof m.value === 'string'
                          ? m.value || t('panels.memoryValueEmpty')
                          : m.value === null || m.value === undefined
                            ? t('panels.memoryValueEmpty')
                            : JSON.stringify(m.value)}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 11, color: 'var(--text-faint)', flexWrap: 'wrap' }}>
                      <span>{t('panels.memoryCreated', { time: formatDateTime(created) })}</span>
                      {showUpdated && <span>{t('panels.memoryUpdated', { time: formatDateTime(m.updated as number) })}</span>}
                      {m.source ? <span>{t('panels.memorySource', { source: m.source })}</span> : null}
                      {typeof m.confidence === 'number' ? <span>{t('panels.memoryConfidence', { pct: Math.round(m.confidence * 100) })}</span> : null}
                    </div>
                  </div>
                  {/* 编辑：进入后只改正文；删除：归档（可在 vault 的 _archive/ 回捞） */}
                  <button
                    onClick={() => (isEditing ? cancelEdit() : startEdit(m))}
                    title={isEditing ? t('common.cancel') : t('panels.memoryEdit')}
                    style={{
                      flexShrink: 0,
                      ...smallIconBtn,
                      color: isHover || isEditing ? 'var(--accent)' : 'var(--text-faint)',
                      opacity: isHover || isEditing ? 1 : 0.45,
                      transition: 'opacity 0.15s ease, color 0.15s ease',
                    }}
                  >
                    <IconEdit />
                  </button>
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
