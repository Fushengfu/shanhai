import { useState, useRef, useEffect } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

declare global {
  interface Window {
    shanhai?: {
      run(message: string): Promise<string>
      onDelta(cb: (text: string) => void): () => void
    }
  }
}

/**
 * 聊天界面：订阅 assistant/delta，流式逐字渲染（「实时蹦出来」）。
 *
 * 主进程 AgentLoop 流式产出 delta → IPC push → 这里 setStreaming 追加，
 * 输入框下方的流式气泡实时增长，任务结束替换为完整消息。
 */
export function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, streaming])

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setStreaming('')
    setBusy(true)

    const off = window.shanhai?.onDelta((chunk) => {
      setStreaming((prev) => prev + chunk)
    })
    try {
      const result = (await window.shanhai?.run(text)) ?? ''
      setMessages((prev) => [...prev, { role: 'assistant', content: result }])
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `错误：${String(err)}` }])
    } finally {
      off?.()
      setStreaming('')
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 16, background: '#fafafa' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 12, textAlign: m.role === 'user' ? 'right' : 'left' }}>
            <span
              style={{
                display: 'inline-block',
                padding: '8px 12px',
                borderRadius: 12,
                background: m.role === 'user' ? '#1677ff' : '#ffffff',
                color: m.role === 'user' ? '#fff' : '#333',
                maxWidth: '80%',
                whiteSpace: 'pre-wrap',
                boxShadow: m.role === 'assistant' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              {m.content}
            </span>
          </div>
        ))}
        {streaming && (
          <div style={{ marginBottom: 12 }}>
            <span
              style={{
                display: 'inline-block',
                padding: '8px 12px',
                borderRadius: 12,
                background: '#ffffff',
                color: '#333',
                maxWidth: '80%',
                whiteSpace: 'pre-wrap',
                boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
              }}
            >
              {streaming}
              <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>
            </span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', padding: 12, borderTop: '1px solid #eee', background: '#fff' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
          autoFocus
          placeholder="输入任务，回车发送"
          style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #ddd', fontSize: 14, outline: 'none' }}
        />
        <button
          onClick={() => void send()}
          disabled={busy}
          style={{
            marginLeft: 8,
            padding: '0 16px',
            borderRadius: 8,
            border: 'none',
            background: '#1677ff',
            color: '#fff',
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          发送
        </button>
      </div>
      <style>{`@keyframes blink { 50% { opacity: 0 } }`}</style>
    </div>
  )
}
