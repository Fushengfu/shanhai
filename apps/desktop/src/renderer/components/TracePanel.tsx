import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconActivity, IconClose } from './icons'
import { makeMarkdownComponents } from './Markdown'
import { ThinkingDots } from './ui'

type TraceEntry = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoningContent?: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  toolCallId?: string
  turn: number
  timestamp: number
}

const ROLE_META: Record<TraceEntry['role'], { label: string; color: string; bg: string }> = {
  system: { label: '系统', color: '#8c8c8c', bg: '#f5f5f5' },
  user: { label: '用户', color: '#1677ff', bg: '#f0f7ff' },
  assistant: { label: '助手', color: '#389e0d', bg: '#f6ffed' },
  tool: { label: '工具', color: '#fa8c16', bg: '#fff7e6' },
}

/** 单条消息痕迹：索引 #N + 角色标签 + 轮次 + 时间 + 元数据（reasoning / tool_calls / tool_call_id）+ 内容 */
function TraceRow({ m, index }: { m: TraceEntry; index: number }) {
  const meta = ROLE_META[m.role]
  const time = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
  return (
    <div style={{ marginBottom: 10, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fff', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: meta.bg, borderBottom: '1px solid #f0f0f0' }}>
        <span style={{ fontSize: 11, color: '#bbb', fontFamily: 'ui-monospace, monospace', flexShrink: 0 }}>#{index}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: meta.color, padding: '1px 8px', borderRadius: 10, background: '#fff', border: `1px solid ${meta.color}` }}>{meta.label}</span>
        {m.turn > 0 && <span style={{ fontSize: 11, color: '#999' }}>第 {m.turn} 轮</span>}
        <span style={{ fontSize: 11, color: '#bbb' }}>{time}</span>
        {m.toolCallId && <span style={{ fontSize: 11, color: '#bbb', fontFamily: 'ui-monospace, monospace' }}>tool_call_id: {m.toolCallId}</span>}
      </div>
      <div style={{ padding: '8px 12px' }}>
        {m.reasoningContent && (
          <div style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 6, background: '#f7f7f8', color: '#888', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>
            <span style={{ color: '#9254de', fontWeight: 600 }}>reasoning_content：</span>
            {m.reasoningContent}
          </div>
        )}
        {m.toolCalls && m.toolCalls.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {m.toolCalls.map((tc) => (
              <div key={tc.id} style={{ padding: '6px 10px', borderRadius: 6, background: '#fff7e6', border: '1px solid #ffe7ba', fontSize: 12 }}>
                <span style={{ color: '#fa8c16', fontWeight: 600 }}>tool_call → {tc.name}</span>
                <span style={{ color: '#bbb', fontFamily: 'ui-monospace, monospace' }}> id={tc.id}</span>
                <pre style={{ margin: '4px 0 0', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#666', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto' }}>
                  {JSON.stringify(tc.args, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
        {m.content ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: '#333', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto', fontFamily: m.role === 'tool' ? 'ui-monospace, monospace' : 'system-ui, sans-serif' }}>
            {m.role === 'assistant' && !m.toolCalls ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(() => undefined)}>
                {m.content}
              </ReactMarkdown>
            ) : (
              m.content
            )}
          </div>
        ) : (
          <div style={{ color: '#ccc', fontSize: 12 }}>（无内容）</div>
        )}
      </div>
    </div>
  )
}

export function TracePanel({ sessionId, busy, streamingReasoning, streaming, onClose }: {
  sessionId: string
  busy: boolean
  streamingReasoning: string
  streaming: string
  onClose: () => void
}) {
  const [trace, setTrace] = useState<TraceEntry[]>([])
  useEffect(() => {
    let alive = true
    void window.shanhai?.getSessionTrace(sessionId).then((t) => { if (alive) setTrace(t ?? []) }).catch(() => undefined)
    return () => { alive = false }
  }, [sessionId])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const roleCount = (r: TraceEntry['role']): number => trace.filter((m) => m.role === r).length
  const toolCallCount = trace.filter((m) => m.toolCalls && m.toolCalls.length > 0).length

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 115, fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '100%', background: '#fff', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600, fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#666' }}><IconActivity /></span>
            执行轨迹
            <span style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>
              消息 {trace.length} · 工具调用 {toolCallCount} · 系统 {roleCount('system')} / 用户 {roleCount('user')} / 助手 {roleCount('assistant')} / 工具 {roleCount('tool')}
            </span>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 4, display: 'inline-flex' }}>
            <IconClose />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {trace.length === 0 && !busy && (
            <div style={{ textAlign: 'center', color: '#bbb', padding: '80px 0', fontSize: 14 }}>暂无执行痕迹，发送一条消息开始</div>
          )}
          {trace.map((m, i) => (
            <TraceRow key={i} m={m} index={i + 1} />
          ))}
          {streamingReasoning && (
            <TraceRow m={{ role: 'assistant', content: '', reasoningContent: streamingReasoning, turn: 0, timestamp: Date.now() }} index={trace.length + 1} />
          )}
          {streaming && (
            <TraceRow m={{ role: 'assistant', content: streaming, turn: 0, timestamp: Date.now() }} index={trace.length + 2} />
          )}
          {busy && !streamingReasoning && !streaming && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#999', fontSize: 13 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#9254de' }} />
              思考中
              <ThinkingDots />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
