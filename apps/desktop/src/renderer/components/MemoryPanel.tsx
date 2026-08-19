import { useCallback, useEffect, useState } from 'react'
import type { MemoryEntry } from '../types'
import { IconClock, IconClose, IconTrash } from './icons'
import { smallIconBtn } from './ui'

const SCOPE_LABEL: Record<string, string> = {
  user_preference: '用户偏好',
  environment: '环境',
  project_knowledge: '项目知识',
  data_cognition: '数据认知',
  task_experience: '任务经验',
  session: '会话',
}

/** 长期记忆面板：展示跨会话记忆（配置型全量 + 经验型召回），支持删除 */
export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const load = useCallback(() => {
    void window.shanhai?.listMemory().then((m) => setMemories(m ?? [])).catch(() => undefined)
  }, [])
  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async (id: number): Promise<void> => {
    await window.shanhai?.removeMemory(id)
    load()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.32)' }} onClick={onClose} />
      <div style={{ position: 'relative', width: 620, maxWidth: '92vw', maxHeight: '78vh', background: '#fff', borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid #f0f0f0' }}>
          <span style={{ color: '#666' }}><IconClock /></span>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#333' }}>长期记忆</span>
          <span style={{ fontSize: 12, color: '#999' }}>共 {memories.length} 条</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', ...smallIconBtn }}>
            <IconClose />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {memories.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#bbb', fontSize: 13 }}>
              暂无长期记忆。
              <br />
              对话中可说「记住我偏好…」，AI 会用 remember 工具保存。
            </div>
          ) : (
            memories.map((m) => (
              <div key={m.id} style={{ marginBottom: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid #f0f0f0', background: '#fafafa', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: '#5b3b8e', padding: '1px 8px', borderRadius: 8, background: '#f3ecff', marginTop: 1 }}>
                  {SCOPE_LABEL[m.scope] ?? m.scope}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 2, wordBreak: 'break-word' }}>{m.key}</div>
                  <div style={{ fontSize: 12, color: '#666', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{typeof m.value === 'string' ? m.value : JSON.stringify(m.value)}</div>
                </div>
                <button onClick={() => void remove(m.id)} title="删除" style={{ flexShrink: 0, ...smallIconBtn, color: '#bbb' }}>
                  <IconTrash />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
