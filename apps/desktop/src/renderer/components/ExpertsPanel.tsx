import { useCallback, useEffect, useState } from 'react'
import type { Expert } from '../types'
import { IconPlus, IconTrash, IconUsers } from './icons'
import { smallIconBtn } from './ui'
import { WindowTitleBar } from './WindowTitleBar'

/** 专家面板：展示多专家编排可用的专家角色（内置 + 自定义），支持新增自定义专家、删除自定义专家。侧滑铺满主区域 */
export function ExpertsPanel({ left, top, onClose, variant = 'panel' }: { left?: number; top?: number; onClose?: () => void; variant?: 'panel' | 'window' }) {
  const [experts, setExperts] = useState<Expert[]>([])
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ id: '', name: '', description: '', systemPrompt: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    void window.shanhai
      ?.listExperts()
      .then((list) => setExperts(list ?? []))
      .catch(() => undefined)
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

  const remove = async (id: string): Promise<void> => {
    try {
      await window.shanhai?.removeExpert(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    setError('')
    load()
  }

  const submit = async (): Promise<void> => {
    const id = form.id.trim()
    const name = form.name.trim()
    if (!id || !name) {
      setError('id 和名称不能为空')
      return
    }
    setSaving(true)
    setError('')
    try {
      await window.shanhai?.addExpert({ id, name, description: form.description.trim(), systemPrompt: form.systemPrompt.trim() })
      setForm({ id: '', name: '', description: '', systemPrompt: '' })
      setShowForm(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '7px 10px',
    borderRadius: 8,
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-sidebar)',
    color: 'var(--text)',
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
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
        icon={<IconUsers />}
        title="专家"
        subtitle="多专家协作可指派的能力角色"
        extra={
          <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 600, color: 'var(--accent)', background: 'var(--tint-blue-soft)', padding: '2px 9px', borderRadius: 10, flexShrink: 0 }}>
            {experts.length} 个
          </span>
        }
        actions={
          <button
            onClick={() => {
              setShowForm((v) => !v)
              setError('')
            }}
            title="新增专家"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
          >
            <IconPlus />
            新增
          </button>
        }
        onClose={() => onClose?.()}
      />

        {/* 新增表单 */}
        {showForm && (
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-sidebar)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <input placeholder="id（短英文，如 security）" value={form.id} onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))} style={inputStyle} />
              <input placeholder="名称（如 安全专家）" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} style={inputStyle} />
            </div>
            <input placeholder="职责（一句话，如 代码安全审计与漏洞排查）" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} style={inputStyle} />
            <textarea placeholder="专属人设（可选，注入该专家执行时的 systemPrompt）" value={form.systemPrompt} onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setShowForm(false); setError('') }} style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
                取消
              </button>
              <button onClick={() => void submit()} disabled={saving} style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        )}

        {/* 专家列表 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          {error && !showForm && <div style={{ fontSize: 12, color: 'var(--danger)', padding: '6px 10px', marginBottom: 8, borderRadius: 8, background: 'var(--tint-red)' }}>{error}</div>}
          {experts.length === 0 ? (
            <div style={{ padding: '56px 0', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, lineHeight: 1.7 }}>
              <span style={{ display: 'inline-flex', width: 48, height: 48, borderRadius: '50%', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-subtle)', color: 'var(--text-faint)', marginBottom: 12 }}>
                <IconUsers />
              </span>
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>暂无专家</div>
            </div>
          ) : (
            experts.map((ex) => {
              const isHover = hoverId === ex.id
              return (
                <div
                  key={ex.id}
                  onMouseEnter={() => setHoverId(ex.id)}
                  onMouseLeave={() => setHoverId((cur) => (cur === ex.id ? null : cur))}
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
                  <span style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: ex.builtin ? 'var(--tint-blue-soft)' : 'var(--tint-purple)', color: ex.builtin ? 'var(--accent)' : 'var(--purple)' }}>
                    <IconUsers />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{ex.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'ui-monospace, monospace' }}>{ex.id}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 8px', borderRadius: 8, background: ex.builtin ? 'var(--tint-blue-soft)' : 'var(--tint-purple)', color: ex.builtin ? 'var(--accent)' : 'var(--purple)' }}>
                        {ex.builtin ? '内置' : '自定义'}
                      </span>
                    </div>
                    {ex.description && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>{ex.description}</div>}
                    {ex.systemPrompt && (
                      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.55, padding: '6px 10px', borderRadius: 8, background: 'var(--bg-subtle)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {ex.systemPrompt}
                      </div>
                    )}
                  </div>
                  {!ex.builtin && (
                    <button
                      onClick={() => void remove(ex.id)}
                      title="删除该自定义专家"
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
                  )}
                </div>
              )
            })
          )}
        </div>
    </div>
  )
}
