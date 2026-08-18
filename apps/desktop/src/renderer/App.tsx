import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface ToolTrace {
  kind: 'tool-call' | 'tool-result'
  sessionId: string
  callId: string
  name: string
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  approvalRequired?: boolean
  approved?: boolean
}

interface ApprovalRequest {
  id: string
  sessionId?: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: string
}

interface GatewayModel {
  id: string
  name: string
  tier: string
  apiKey: string
  baseUrl: string
  custom?: boolean
}

interface ContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'input_video'
  text?: string
  image_url?: { url: string }
  input_audio?: { data: string; format: string }
  input_video?: { data: string; format: string }
}

type HistoryItem =
  | { kind: 'user'; content?: string; attachments?: unknown[] }
  | { kind: 'assistant'; content?: string }
  | { kind: 'tool'; trace?: ToolTrace }

declare global {
  interface Window {
    shanhai?: {
      status(): Promise<{ loggedIn: boolean; username: string | null }>
      login(u: string, p: string): Promise<{ username: string; nickname?: string }>
      logout(): Promise<void>
      listModels(): Promise<GatewayModel[]>
      addCustomModel(model: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<GatewayModel>
      removeCustomModel(id: string): Promise<void>
      listSessions(): Promise<Array<{ id: string; title: string }>>
      createSession(title?: string): Promise<string>
      switchSession(id: string): Promise<void>
      getSessionHistory(id?: string): Promise<HistoryItem[]>
      respondApproval(outcome: 'allowed-once' | 'rejected', requestId: string): Promise<void>
      run(message: string, attachments?: ContentPart[]): Promise<string>
      onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void
      onToolTrace(cb: (trace: ToolTrace) => void): () => void
      onDelta(cb: (sessionId: string, text: string) => void): () => void
      switchModel(id: string): Promise<void>
      getCurrentModelId(): Promise<string>
      stop(): Promise<void>
      speak(text: string): Promise<void>
      screenshot(): Promise<string>
    }
  }
}

type ChatItem =
  | { kind: 'user'; content: string; images?: string[] }
  | { kind: 'assistant'; content: string }
  | { kind: 'tool'; trace: ToolTrace }

/** 每个会话独立的 UI 状态（支持并行会话：切换会话后，后台会话继续跑，互不串扰） */
interface SessionUIState {
  items: ChatItem[]
  streaming: string
  busy: boolean
}

const EMPTY_SESSION: SessionUIState = { items: [], streaming: '', busy: false }

export function App() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [username, setUsername] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([])
  const [currentSessionId, setCurrentSessionId] = useState('')
  const [sessionMap, setSessionMap] = useState<Record<string, SessionUIState>>({})
  const loadedSessions = useRef<Set<string>>(new Set())
  const [models, setModels] = useState<GatewayModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [attachments, setAttachments] = useState<Array<{ type: 'image' | 'audio' | 'video'; name: string; dataUrl: string }>>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const cur = sessionMap[currentSessionId] ?? EMPTY_SESSION
  const systemModels = models.filter((m) => !m.custom)
  const customModels = models.filter((m) => m.custom)

  const patchSession = useCallback(
    (id: string, patch: Partial<SessionUIState> | ((s: SessionUIState) => Partial<SessionUIState>)) => {
      setSessionMap((prev) => {
        const base = prev[id] ?? EMPTY_SESSION
        const next = typeof patch === 'function' ? { ...base, ...patch(base) } : { ...base, ...patch }
        return { ...prev, [id]: next }
      })
    },
    [],
  )

  useEffect(() => {
    const api = window.shanhai
    if (!api) return
    void api.status().then((s) => {
      setLoggedIn(s.loggedIn)
      setUsername(s.username)
    })
    void api
      .listSessions()
      .then((list) => {
        setSessions(list)
        const first = list[0]
        if (first) {
          void switchToSession(first.id)
        }
      })
      .catch(() => undefined)
    void api.listModels().then(async (list) => {
      setModels(list)
      const current = await api.getCurrentModelId()
      setSelectedModel(current && list.some((m) => m.id === current) ? current : (list[0]?.id ?? ''))
    })
    const offDelta = api.onDelta((sessionId, text) => {
      patchSession(sessionId, (s) => ({ streaming: s.streaming + text }))
    })
    const offTrace = api.onToolTrace((trace) => {
      patchSession(trace.sessionId, (s) => {
        if (trace.kind === 'tool-result') {
          const idx = [...s.items].reverse().findIndex((it) => it.kind === 'tool' && it.trace.callId === trace.callId)
          if (idx >= 0) {
            const arr = [...s.items]
            const realIdx = arr.length - 1 - idx
            arr[realIdx] = { kind: 'tool', trace: { ...trace, result: trace.result, error: trace.error } }
            return { items: arr }
          }
        }
        return { items: [...s.items, { kind: 'tool', trace }] }
      })
    })
    const offApproval = api.onApprovalRequest((req) => setPendingApproval(req))
    return () => {
      offDelta()
      offTrace()
      offApproval()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchSession])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [cur.items, cur.streaming, pendingApproval])

  async function refreshSessions(): Promise<void> {
    const list = (await window.shanhai?.listSessions()) ?? []
    setSessions(list)
  }

  async function switchToSession(id: string): Promise<void> {
    setCurrentSessionId(id)
    setInput('')
    setAttachments([])
    setPendingApproval(null)
    await window.shanhai?.switchSession(id)
    if (loadedSessions.current.has(id)) return
    loadedSessions.current.add(id)
    const history = (await window.shanhai?.getSessionHistory(id)) ?? []
    const items = historyToItems(history)
    patchSession(id, { items, streaming: '', busy: false })
  }

  async function createSession(): Promise<void> {
    const id = await window.shanhai?.createSession()
    if (!id) return
    loadedSessions.current.add(id)
    patchSession(id, { items: [], streaming: '', busy: false })
    setCurrentSessionId(id)
    setInput('')
    setAttachments([])
    setPendingApproval(null)
    await refreshSessions()
  }

  async function handleLogin(u: string, p: string): Promise<void> {
    const r = await window.shanhai!.login(u, p)
    setLoggedIn(true)
    setUsername(r.username)
    setLoginOpen(false)
    // 登录成功后刷新模型列表（含 apiKey/baseUrl），切换到真实网关模型
    const list = await window.shanhai!.listModels()
    setModels(list)
    const current = await window.shanhai!.getCurrentModelId()
    setSelectedModel(current && list.some((m) => m.id === current) ? current : (list[0]?.id ?? ''))
  }

  async function handleLogout(): Promise<void> {
    await window.shanhai?.logout()
    setLoggedIn(false)
    setUsername(null)
    setModels([])
    setSelectedModel('')
  }

  async function handleAddModel(input: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<void> {
    const m = await window.shanhai?.addCustomModel(input)
    if (m) {
      setModels((prev) => [...prev, m])
      setSelectedModel(m.id)
      await window.shanhai?.switchModel(m.id)
      setModelMenuOpen(false)
    }
  }

  async function handleRemoveModel(id: string): Promise<void> {
    await window.shanhai?.removeCustomModel(id)
    setModels((prev) => prev.filter((m) => m.id !== id))
    if (selectedModel === id) setSelectedModel('')
  }

  async function send(): Promise<void> {
    const sid = currentSessionId
    if (!sid) return
    const text = input.trim()
    if ((!text && attachments.length === 0) || cur.busy) return
    setInput('')
    const images = attachments.filter((a) => a.type === 'image').map((a) => a.dataUrl)
    const parts: ContentPart[] = attachments.map((a) => {
      if (a.type === 'image') return { type: 'image_url', image_url: { url: a.dataUrl } }
      const m = /^data:([^;]+);base64,(.+)$/.exec(a.dataUrl)
      const mime = m?.[1] ?? ''
      const data = m?.[2] ?? ''
      const format = mime.split('/')[1] ?? ''
      return a.type === 'audio'
        ? { type: 'input_audio', input_audio: { data, format } }
        : { type: 'input_video', input_video: { data, format } }
    })
    patchSession(sid, (s) => ({
      items: [...s.items, { kind: 'user', content: text, images }],
      streaming: '',
      busy: true,
    }))
    setAttachments([])
    try {
      const result = (await window.shanhai?.run(text, parts)) ?? ''
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: result }] }))
    } catch (err) {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }] }))
    } finally {
      patchSession(sid, { streaming: '', busy: false })
    }
  }

  async function respondApproval(outcome: 'allowed-once' | 'rejected'): Promise<void> {
    if (pendingApproval) {
      await window.shanhai?.respondApproval(outcome, pendingApproval.id)
      setPendingApproval(null)
    }
  }

  function speakLast(): void {
    const last = [...cur.items].reverse().find((it) => it.kind === 'assistant')
    if (last && last.kind === 'assistant') {
      void window.shanhai?.speak(last.content)
    }
  }

  function stopSend(): void {
    void window.shanhai?.stop()
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = e.target.files
    if (!files) return
    for (const file of Array.from(files)) {
      const type = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('audio/')
          ? 'audio'
          : file.type.startsWith('video/')
            ? 'video'
            : null
      if (!type) continue
      const dataUrl = await readFileAsDataUrl(file)
      setAttachments((prev) => [...prev, { type, name: file.name, dataUrl }])
    }
    e.target.value = ''
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          const dataUrl = await readFileAsDataUrl(file)
          setAttachments((prev) => [...prev, { type: 'image', name: `pasted-${Date.now()}.png`, dataUrl }])
        }
      }
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      {/* 侧边栏：会话列表（可折叠） */}
      <aside
        style={
          {
            width: sidebarCollapsed ? 0 : 200,
            borderRight: sidebarCollapsed ? 'none' : '1px solid #eee',
            background: '#f7f7f8',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            transition: 'width 0.2s ease',
            WebkitAppRegion: 'drag',
          } as React.CSSProperties
        }
      >
        <div style={{ padding: '42px 12px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>会话</span>
          <button onClick={() => void createSession()} title="新增会话" style={smallIconBtn}>
            <IconPlus />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => void switchToSession(s.id)}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: 13,
                color: '#333',
                borderBottom: '1px solid #eee',
                background: s.id === currentSessionId ? '#e8f1ff' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
              {(sessionMap[s.id]?.busy ?? false) && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1677ff', flexShrink: 0, marginLeft: 6 }} />
              )}
            </div>
          ))}
        </div>
        {/* 侧边栏底部：账号头像 + 昵称 + 退出（未登录点击头像弹登录窗） */}
        <div style={{ padding: 12, borderTop: '1px solid #eee', display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div
            onClick={() => {
              if (!loggedIn) setLoginOpen(true)
            }}
            title={loggedIn ? username ?? '' : '点击登录'}
            style={{ width: 32, height: 32, borderRadius: '50%', background: loggedIn ? '#1677ff' : '#d9d9d9', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: loggedIn ? 'default' : 'pointer' }}
          >
            <IconAvatar />
          </div>
          <div
            onClick={() => {
              if (!loggedIn) setLoginOpen(true)
            }}
            style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: loggedIn ? 'default' : 'pointer' }}
          >
            {loggedIn ? (username ?? '已登录') : '未登录'}
          </div>
          {loggedIn && (
            <button onClick={() => void handleLogout()} title="退出登录" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 4, display: 'inline-flex' }}>
              <IconLogout />
            </button>
          )}
        </div>
      </aside>

      {/* 主区 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minWidth: 0 }}>
        {/* 顶栏（可拖拽窗口）+ 侧边栏折叠按钮 */}
        <header
          style={
            {
              padding: '12px 16px 12px 80px',
              borderBottom: '1px solid #eee',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              WebkitAppRegion: 'drag',
            } as React.CSSProperties
          }
        >
          <button onClick={() => setSidebarCollapsed((v) => !v)} title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} style={{ ...smallIconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <IconSidebar />
          </button>
          <div style={{ fontWeight: 600, fontSize: 14 }}>山海</div>
        </header>

        {/* 消息区 */}
        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 16, background: '#fafafa' }}>
          {cur.items.map((it, i) => {
            if (it.kind === 'user') {
              return (
                <div key={i} style={{ marginBottom: 12, textAlign: 'right' }}>
                  {it.images?.map((img, j) => (
                    <img
                      key={j}
                      src={img}
                      alt="附件"
                      style={{ maxWidth: 200, maxHeight: 200, borderRadius: 8, display: 'block', marginLeft: 'auto', marginBottom: 4, objectFit: 'cover' }}
                    />
                  ))}
                  {it.content && <span style={bubble('#1677ff', '#fff')}>{it.content}</span>}
                </div>
              )
            }
            if (it.kind === 'assistant') {
              return (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'inline-block', maxWidth: '85%', minWidth: 0, padding: '10px 14px', borderRadius: 12, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.08)', fontSize: 14, lineHeight: 1.6, color: '#333', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {it.content}
                    </ReactMarkdown>
                  </div>
                </div>
              )
            }
            // 工具过程（按类型显示：调用 / 结果）
            const t = it.trace
            return (
              <div key={i} style={{ marginBottom: 8, fontSize: 12 }}>
                <div style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 4, padding: '6px 10px', borderRadius: 8, background: t.error ? '#fff2f0' : '#f0f0f0', color: t.error ? '#cf1322' : '#555', maxWidth: '90%' }}>
                  {t.kind === 'tool-call' ? <IconWrench /> : <IconCheck />}
                  <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    {t.kind === 'tool-call'
                      ? `调用工具 ${t.name}(${JSON.stringify(t.args ?? {})})`
                      : `${t.name}${t.error ? ' 出错: ' + t.error : ' → ' + JSON.stringify(t.result)}`}
                  </span>
                </div>
              </div>
            )
          })}
          {cur.streaming && (
            <div style={{ marginBottom: 12 }}>
              <span style={bubble('#fff', '#333')}>
                {cur.streaming}
                <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>
              </span>
            </div>
          )}
        </div>

        {/* 审批弹窗（输入框上方浮动） */}
        {pendingApproval && (
          <div
            style={{
              position: 'absolute',
              bottom: 158,
              left: 16,
              right: 16,
              padding: 14,
              borderRadius: 12,
              border: '1px solid #ffccc7',
              background: '#fff2f0',
              fontSize: 13,
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6, color: '#333' }}>
              <IconWarn />
              需要确认危险操作
            </div>
            <div style={{ color: '#555', marginBottom: 4 }}>工具：{pendingApproval.toolName}（风险 {pendingApproval.riskLevel}）</div>
            <div style={{ color: '#888', marginBottom: 10, whiteSpace: 'pre-wrap', fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
              {JSON.stringify(pendingApproval.args, null, 2)}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void respondApproval('allowed-once')} style={btn('#1677ff', '#fff')}>
                允许一次
              </button>
              <button onClick={() => void respondApproval('rejected')} style={btn('#fff', '#333', '1px solid #ddd')}>
                拒绝
              </button>
            </div>
          </div>
        )}

        {/* 输入区（单卡片：textarea + 底部功能行 + 发送按钮） */}
        <div style={{ padding: '12px 16px 16px', borderTop: '1px solid #eee', background: '#fff' }}>
          <div style={{ border: '1px solid #d9d9d9', borderRadius: 16, padding: '10px 12px 8px 16px', background: '#fff' }}>
            {attachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {attachments.map((a, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    {a.type === 'image' ? (
                      <img src={a.dataUrl} alt={a.name} style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid #eee', display: 'block' }} />
                    ) : (
                      <div style={{ width: 56, height: 56, borderRadius: 8, border: '1px solid #eee', background: '#f7f7f8', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
                        {a.type === 'audio' ? <IconMic /> : <IconMonitor />}
                      </div>
                    )}
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                      style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', border: 'none', background: '#ff4d4f', color: '#fff', fontSize: 12, lineHeight: '18px', cursor: 'pointer', padding: 0 }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*,audio/*,video/*" multiple style={{ display: 'none' }} onChange={(e) => void handleFileSelect(e)} />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              onPaste={(e) => void handlePaste(e)}
              autoFocus
              rows={3}
              placeholder="输入任务，Enter 发送，Shift+Enter 换行"
              style={{ width: '100%', border: 'none', outline: 'none', resize: 'none', fontSize: 14, lineHeight: 1.6, background: 'transparent', minHeight: 60, maxHeight: 200, fontFamily: 'inherit', display: 'block', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button title="附件" onClick={() => fileRef.current?.click()} style={iconBtn}><IconPaperclip /></button>
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => setModelMenuOpen((v) => !v)}
                    style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 12, color: '#555', background: '#fff', outline: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    {models.find((m) => m.id === selectedModel)?.name ?? (loggedIn ? '选择模型' : '未登录')}
                    <IconChevronDown />
                  </button>
                  {modelMenuOpen && (
                    <div style={{ position: 'absolute', bottom: '110%', left: 0, minWidth: 260, maxHeight: 360, overflowY: 'auto', background: '#fff', border: '1px solid #e0e0e0', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 20, padding: 4 }}>
                      <div style={{ padding: '6px 10px', fontSize: 11, color: '#999', fontWeight: 600 }}>系统内置</div>
                      {systemModels.length === 0 ? (
                        <div style={{ padding: '8px 10px', color: '#bbb', fontSize: 12 }}>请先登录以加载模型</div>
                      ) : (
                        systemModels.map((m) => (
                          <div
                            key={m.id}
                            onClick={() => {
                              setSelectedModel(m.id)
                              void window.shanhai?.switchModel(m.id)
                              setModelMenuOpen(false)
                            }}
                            style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: m.id === selectedModel ? '#1677ff' : '#333', background: m.id === selectedModel ? '#f0f5ff' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                          >
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                            {m.id === selectedModel && <IconCheck />}
                          </div>
                        ))
                      )}
                      {customModels.length > 0 && (
                        <div style={{ padding: '6px 10px', fontSize: 11, color: '#999', fontWeight: 600, marginTop: 4, borderTop: '1px solid #f0f0f0' }}>我的模型</div>
                      )}
                      {customModels.map((m) => (
                        <div
                          key={m.id}
                          onClick={() => {
                            setSelectedModel(m.id)
                            void window.shanhai?.switchModel(m.id)
                            setModelMenuOpen(false)
                          }}
                          style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: m.id === selectedModel ? '#1677ff' : '#333', background: m.id === selectedModel ? '#f0f5ff' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {m.id === selectedModel && <IconCheck />}
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleRemoveModel(m.id)
                              }}
                              title="删除"
                              style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 0, display: 'inline-flex' }}
                            >
                              <IconClose />
                            </button>
                          </span>
                        </div>
                      ))}
                      <div style={{ borderTop: '1px solid #f0f0f0', marginTop: 4, paddingTop: 4 }}>
                        <button
                          onClick={() => {
                            setModelMenuOpen(false)
                            setAddModelOpen(true)
                          }}
                          style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px dashed #d9d9d9', background: '#fff', cursor: 'pointer', fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                        >
                          <IconPlus /> 添加自定义模型
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button title="操作电脑" onClick={() => void window.shanhai?.screenshot()} style={iconBtn}><IconMonitor /></button>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button title="语音朗读" onClick={speakLast} style={iconBtn}><IconMic /></button>
                <button
                  onClick={() => (cur.busy ? stopSend() : void send())}
                  disabled={!cur.busy && !input.trim()}
                  title={cur.busy ? '停止' : '发送'}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    border: 'none',
                    background: cur.busy ? '#ff4d4f' : !input.trim() ? '#d9d9d9' : '#1677ff',
                    color: '#fff',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: !cur.busy && !input.trim() ? 'not-allowed' : 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {cur.busy ? <IconStop /> : <IconSend />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 登录弹窗（未登录时点左下角头像弹出；登录态下主界面照常可用） */}
      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} onLogin={handleLogin} />}

      {/* 添加自定义模型弹窗 */}
      {addModelOpen && <AddModelModal onClose={() => setAddModelOpen(false)} onAdd={handleAddModel} />}

      <style>{`@keyframes blink { 50% { opacity: 0 } }`}</style>
    </div>
  )
}

function historyToItems(history: HistoryItem[]): ChatItem[] {
  const out: ChatItem[] = []
  for (const h of history) {
    if (h.kind === 'user') {
      const images = (h.attachments ?? [])
        .map((a) => (a as ContentPart)?.image_url?.url)
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
      out.push({ kind: 'user', content: h.content ?? '', images })
    } else if (h.kind === 'assistant') {
      out.push({ kind: 'assistant', content: h.content ?? '' })
    } else if (h.trace) {
      out.push({ kind: 'tool', trace: h.trace })
    }
  }
  return out
}

function bubble(bg: string, color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '8px 12px',
    borderRadius: 12,
    background: bg,
    color,
    maxWidth: '80%',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
    boxShadow: bg === '#fff' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
  }
}

function btn(bg: string, color: string, border?: string): React.CSSProperties {
  return { padding: '6px 14px', borderRadius: 8, border: border ?? 'none', background: bg, color, fontSize: 13, cursor: 'pointer' }
}

const iconBtn: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid #eee',
  background: '#fff',
  fontSize: 14,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#555',
}

const smallIconBtn: React.CSSProperties = {
  padding: 4,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#666',
}

// SVG 图标（禁止字符图标，统一用内联 SVG 线条图标）
function IconSend() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  )
}

function IconMic() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
      <path d="M12 19v3" />
    </svg>
  )
}

function IconMonitor() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  )
}

function IconPaperclip() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function IconWrench() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 4 }}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 4 }}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

function IconWarn() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 4 }}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

function IconAvatar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  )
}

function IconLogout() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

function IconStop() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function IconChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function IconSidebar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function IconClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// Markdown 渲染组件（代码块高亮 / 行内代码 / 链接 / 图片宽度限制）
const markdownComponents = {
  code(props: { className?: string; children?: React.ReactNode }) {
    const hasLang = /language-[\w-]+/.test(props.className ?? '')
    if (!props.className || !hasLang) {
      return (
        <code style={{ background: '#f0f0f0', padding: '2px 5px', borderRadius: 4, fontSize: '0.9em', fontFamily: 'ui-monospace, monospace' }}>
          {props.children}
        </code>
      )
    }
    return (
      <pre style={{ background: '#282c34', color: '#abb2bf', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: 13, lineHeight: 1.55, margin: '8px 0' }}>
        <code style={{ fontFamily: 'ui-monospace, monospace' }}>{props.children}</code>
      </pre>
    )
  },
  a(props: { href?: string; children?: React.ReactNode }) {
    return (
      <a href={props.href} target="_blank" rel="noreferrer" style={{ color: '#1677ff' }}>
        {props.children}
      </a>
    )
  },
  img(props: { src?: string; alt?: string }) {
    return <img src={props.src} alt={props.alt} style={{ maxWidth: '100%', height: 'auto', borderRadius: 8, display: 'block' }} />
  },
}

function LoginModal({ onClose, onLogin }: { onClose: () => void; onLogin: (u: string, p: string) => Promise<void> }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(): Promise<void> {
    if (!u || !p) return
    setLoading(true)
    setErr('')
    try {
      await onLogin(u, p)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: 'system-ui, sans-serif' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 340, padding: 32, background: '#fff', borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.15)', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 12, border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 4 }}>
          <IconClose />
        </button>
        <h1 style={{ fontSize: 20, marginBottom: 4, textAlign: 'center' }}>山海</h1>
        <p style={{ fontSize: 13, color: '#888', textAlign: 'center', marginBottom: 24 }}>账号密码登录</p>
        <input
          value={u}
          onChange={(e) => setU(e.target.value)}
          placeholder="账号"
          autoFocus
          style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ddd', fontSize: 14, marginBottom: 12, boxSizing: 'border-box', outline: 'none' }}
        />
        <input
          value={p}
          onChange={(e) => setP(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          type="password"
          placeholder="密码"
          style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ddd', fontSize: 14, marginBottom: 12, boxSizing: 'border-box', outline: 'none' }}
        />
        {err && <p style={{ color: '#ff4d4f', fontSize: 12, marginBottom: 8, wordBreak: 'break-word' }}>{err}</p>}
        <button onClick={() => void submit()} disabled={loading} style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none', background: '#1677ff', color: '#fff', fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
          {loading ? '登录中…' : '登录'}
        </button>
        <p style={{ fontSize: 11, color: '#bbb', textAlign: 'center', marginTop: 16 }}>密码仅在登录瞬间使用，绝不落盘</p>
      </div>
    </div>
  )
}

function AddModelModal({ onClose, onAdd }: { onClose: () => void; onAdd: (m: { name: string; baseUrl: string; apiKey: string; model: string }) => Promise<void> }) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(): Promise<void> {
    if (!name || !baseUrl || !apiKey || !model) {
      setErr('请填写完整：名称、端点、API Key、模型参数')
      return
    }
    setLoading(true)
    setErr('')
    try {
      await onAdd({ name, baseUrl, apiKey, model })
      onClose()
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 110, fontFamily: 'system-ui, sans-serif' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 360, padding: 28, background: '#fff', borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.15)', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 12, border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 4 }}>
          <IconClose />
        </button>
        <h2 style={{ fontSize: 17, marginBottom: 4, textAlign: 'center' }}>添加自定义模型</h2>
        <p style={{ fontSize: 12, color: '#888', textAlign: 'center', marginBottom: 20 }}>接入你自己的 OpenAI 兼容端点</p>
        <Field label="名称" value={name} onChange={setName} placeholder="例如：我的 GPT-4o" />
        <Field label="端点 (baseUrl)" value={baseUrl} onChange={setBaseUrl} placeholder="https://api.openai.com/v1" />
        <Field label="API Key" value={apiKey} onChange={setApiKey} placeholder="sk-..." password />
        <Field label="模型参数 (model)" value={model} onChange={setModel} placeholder="gpt-4o" />
        {err && <p style={{ color: '#ff4d4f', fontSize: 12, marginBottom: 8, wordBreak: 'break-word' }}>{err}</p>}
        <button onClick={() => void submit()} disabled={loading} style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none', background: '#1677ff', color: '#fff', fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
          {loading ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, password }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; password?: boolean }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={password ? 'password' : 'text'}
        placeholder={placeholder}
        style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
      />
    </div>
  )
}
