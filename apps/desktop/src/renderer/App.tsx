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
  model?: string
  custom?: boolean
}

interface ContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'input_video'
  text?: string
  image_url?: { url: string }
  input_audio?: { data: string; format: string }
  input_video?: { data: string; format: string }
}

interface TokenSnapshot {
  totalPrompt: number
  totalCompletion: number
  total: number
  turnPrompt: number
  turnCompletion: number
  turn: number
  contextLength: number
  lastPrompt: number
  contextUsageRatio: number
  turnCount: number
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
      updateCustomModel(id: string, model: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<GatewayModel>
      removeCustomModel(id: string): Promise<void>
      listSessions(): Promise<Array<{ id: string; title: string; workDir: string }>>
      createSession(title?: string, workdir?: string): Promise<string>
      switchSession(id: string): Promise<void>
      renameSession(id: string, title: string): Promise<void>
      deleteSession(id: string): Promise<void>
      getSessionWorkdir(id?: string): Promise<string>
      setSessionWorkdir(id: string, workdir: string): Promise<void>
      selectDirectory(defaultPath?: string): Promise<string | null>
      getSessionHistory(id?: string): Promise<HistoryItem[]>
      respondApproval(outcome: 'allowed-once' | 'rejected', requestId: string): Promise<void>
      run(message: string, attachments?: ContentPart[]): Promise<string>
      resend(sessionId: string, userMessageIndex: number, newContent?: string): Promise<string>
      resume(sessionId: string): Promise<string>
      hasIncompleteTurn(sessionId: string): Promise<boolean>
      getApprovalPolicy(): Promise<'ask' | 'never'>
      setApprovalPolicy(policy: 'ask' | 'never'): Promise<void>
      onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void
      onToolTrace(cb: (trace: ToolTrace) => void): () => void
      onDelta(cb: (sessionId: string, text: string) => void): () => void
      switchModel(id: string): Promise<void>
      getCurrentModelId(): Promise<string>
      stop(): Promise<void>
      speak(text: string): Promise<void>
      screenshot(): Promise<string>
      getTokenStats(): Promise<TokenSnapshot>
      onTokenStats(cb: (stats: TokenSnapshot) => void): () => void
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
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; workDir: string }>>([])
  const [currentSessionId, setCurrentSessionId] = useState('')
  const [sessionMap, setSessionMap] = useState<Record<string, SessionUIState>>({})
  const loadedSessions = useRef<Set<string>>(new Set())
  const [models, setModels] = useState<GatewayModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [customModelDrawerOpen, setCustomModelDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const [tokenStats, setTokenStats] = useState<TokenSnapshot | null>(null)
  const [attachments, setAttachments] = useState<Array<{ type: 'image' | 'audio' | 'video'; name: string; dataUrl: string }>>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // 安全模式（审批策略）：ask=危险操作每次询问，never=从不询问直接执行
  const [approvalPolicy, setApprovalPolicyState] = useState<'ask' | 'never'>('ask')
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false)
  const approvalMenuRef = useRef<HTMLDivElement>(null)
  // 当前会话是否有「未完成的消息」（用于显示「继续执行」按钮）
  const [incompleteTurn, setIncompleteTurn] = useState(false)
  // 消息队列：任务执行中提交的新消息进入队列，任务完成后自动执行（队列模式）
  const pendingQueue = useRef<Record<string, Array<{ text: string; parts: ContentPart[]; images: string[] }>>>({})
  // 当前会话排队中的消息数（UI 提示「排队中 N 条」）
  const [queueCount, setQueueCount] = useState(0)

  const cur = sessionMap[currentSessionId] ?? EMPTY_SESSION
  const systemModels = models.filter((m) => !m.custom)
  const customModels = models.filter((m) => m.custom)
  const workDir = sessions.find((s) => s.id === currentSessionId)?.workDir ?? ''
  const workDirName = workDir ? (workDir.split(/[\\/]/).filter(Boolean).pop() ?? '工作目录') : '选择目录'

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
    const offToken = api.onTokenStats((s) => setTokenStats(s))
    void api.getTokenStats().then((s) => setTokenStats(s)).catch(() => undefined)
    void api.getApprovalPolicy().then((p) => setApprovalPolicyState(p)).catch(() => undefined)
    return () => {
      offDelta()
      offTrace()
      offApproval()
      offToken()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchSession])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [cur.items, cur.streaming, pendingApproval])

  // 模型下拉：点击窗口其他位置时关闭弹窗
  useEffect(() => {
    if (!modelMenuOpen) return
    function onDown(e: MouseEvent): void {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [modelMenuOpen])

  // 安全模式下拉：点击窗口其他位置时关闭
  useEffect(() => {
    if (!approvalMenuOpen) return
    function onDown(e: MouseEvent): void {
      if (approvalMenuRef.current && !approvalMenuRef.current.contains(e.target as Node)) {
        setApprovalMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [approvalMenuOpen])

  async function refreshSessions(): Promise<void> {
    const list = (await window.shanhai?.listSessions()) ?? []
    setSessions(list)
  }

  async function renameSession(id: string, title: string): Promise<void> {
    await window.shanhai?.renameSession(id, title)
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
  }

  async function deleteSession(id: string): Promise<void> {
    await window.shanhai?.deleteSession(id)
    setSessionMap((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    loadedSessions.current.delete(id)
    await refreshSessions()
    // 若删除的是当前会话，切到剩余第一个
    if (id === currentSessionId) {
      const list = await window.shanhai!.listSessions()
      if (list[0]) void switchToSession(list[0].id)
      else setCurrentSessionId('')
    }
  }

  async function saveWorkdir(wd: string): Promise<void> {
    const sid = currentSessionId
    if (!sid || !wd) return
    await window.shanhai?.setSessionWorkdir(sid, wd)
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, workDir: wd } : s)))
  }

  async function pickWorkdir(): Promise<void> {
    const sid = currentSessionId
    if (!sid) return
    const current = sessions.find((s) => s.id === sid)?.workDir ?? ''
    const picked = await window.shanhai?.selectDirectory(current)
    if (!picked) return
    await saveWorkdir(picked)
  }

  async function switchToSession(id: string): Promise<void> {
    setCurrentSessionId(id)
    setInput('')
    setAttachments([])
    setPendingApproval(null)
    await window.shanhai?.switchSession(id)
    // 检查是否有未完成的消息（决定是否显示「继续执行」按钮）
    const incomplete = (await window.shanhai?.hasIncompleteTurn(id)) ?? false
    setIncompleteTurn(incomplete)
    setQueueCount(pendingQueue.current[id]?.length ?? 0)
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

  async function handleUpdateModel(id: string, input: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<void> {
    const m = await window.shanhai?.updateCustomModel(id, input)
    if (m) {
      setModels((prev) => prev.map((x) => (x.id === id ? m : x)))
    }
  }

  async function handleRemoveModel(id: string): Promise<void> {
    await window.shanhai?.removeCustomModel(id)
    setModels((prev) => prev.filter((m) => m.id !== id))
    if (selectedModel === id) setSelectedModel('')
  }

  /** 切换安全模式（审批策略）并持久化 */
  function switchApprovalPolicy(policy: 'ask' | 'never'): void {
    setApprovalPolicyState(policy)
    setApprovalMenuOpen(false)
    void window.shanhai?.setApprovalPolicy(policy)
  }

  /** 队列模式：任务执行中提交的消息进入队列，任务完成后自动逐条执行（对齐 taco 的 addToQueue/injectQueuedMessage） */
  async function doRun(sid: string, text: string, parts: ContentPart[], images: string[]): Promise<void> {
    patchSession(sid, (s) => ({ items: [...s.items, { kind: 'user', content: text, images }], streaming: '', busy: true }))
    try {
      const result = (await window.shanhai?.run(text, parts)) ?? ''
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: result }] }))
    } catch (err) {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }] }))
    } finally {
      patchSession(sid, { streaming: '', busy: false })
      setIncompleteTurn(false)
      // 出队：执行队列中下一条消息
      const q = pendingQueue.current[sid]
      if (q && q.length > 0) {
        const next = q.shift()!
        if (sid === currentSessionId) setQueueCount(q.length)
        void doRun(sid, next.text, next.parts, next.images)
      }
    }
  }

  async function send(): Promise<void> {
    const sid = currentSessionId
    if (!sid) return
    const text = input.trim()
    if (!text && attachments.length === 0) return
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
    setInput('')
    setAttachments([])
    if (cur.busy) {
      // 当前任务执行中：新消息进入队列，任务完成后自动执行（队列模式，不丢弃）
      pendingQueue.current[sid] = [...(pendingQueue.current[sid] ?? []), { text, parts, images }]
      setQueueCount(pendingQueue.current[sid].length)
      return
    }
    void doRun(sid, text, parts, images)
  }

  async function respondApproval(outcome: 'allowed-once' | 'rejected'): Promise<void> {
    if (pendingApproval) {
      await window.shanhai?.respondApproval(outcome, pendingApproval.id)
      setPendingApproval(null)
    }
  }

  /** 重新发送：截断到该用户消息重新生成（对齐 taco 的 resendFromExisting，直接重发，不填回输入框） */
  function resendMessage(userIndex: number): void {
    const sid = currentSessionId
    if (!sid) return
    // 先从前端视图移除该消息及其后的回复，再走后端截断 + 重跑
    void window.shanhai?.resend(sid, userIndex).then((result) => {
      patchSession(sid, (s) => {
        // 前端重新加载历史，拿到截断后的最新状态
        return { items: s.items, streaming: '', busy: false }
      })
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }] }))
    })
  }

  /** 编辑后重发：截断到该消息，用新内容重新生成 */
  function editResend(userIndex: number, newContent: string): void {
    const sid = currentSessionId
    if (!sid) return
    void window.shanhai?.resend(sid, userIndex, newContent).then((result) => {
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }] }))
    })
  }

  /** 继续执行：把最后一条未完成的用户消息重新生成（断点恢复） */
  function resumeMessage(): void {
    const sid = currentSessionId
    if (!sid) return
    void window.shanhai?.resume(sid).then((result) => {
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }] }))
    })
  }

  /** 从后端重新拉取会话历史，刷新前端视图（重发/编辑/续跑后截断状态与后端对齐） */
  async function reloadSessionItems(sid: string, _result: string): Promise<void> {
    const history = (await window.shanhai?.getSessionHistory(sid)) ?? []
    patchSession(sid, { items: historyToItems(history), streaming: '', busy: false })
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
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: 'system-ui, sans-serif' }}>
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
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === currentSessionId}
              busy={sessionMap[s.id]?.busy ?? false}
              editing={editingSessionId === s.id}
              editingTitle={editingTitle}
              onTitleChange={setEditingTitle}
              onStartEdit={() => {
                setEditingSessionId(s.id)
                setEditingTitle(s.title)
              }}
              onCommitEdit={() => {
                void renameSession(s.id, editingTitle)
                setEditingSessionId(null)
              }}
              onCancelEdit={() => setEditingSessionId(null)}
              onDelete={() => void deleteSession(s.id)}
              onSelect={() => void switchToSession(s.id)}
            />
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
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
        <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 16, background: '#fafafa' }}>
          {(() => {
            let userIdx = 0
            return cur.items.map((it, i) => {
              if (it.kind === 'user') {
                const idx = userIdx++
                return <UserMessage key={i} content={it.content} images={it.images} userIndex={idx} busy={cur.busy} onResend={resendMessage} onEditResend={editResend} />
              }
              if (it.kind === 'assistant') {
                return <AssistantMessage key={i} content={it.content} />
              }
              // 工具过程（按类型渲染：调用 / 完成 / 出错，点击展开查看详情）
              const t = it.trace
              return <ToolStep key={i} trace={t} />
            })
          })()}
          {cur.busy && !cur.streaming && (
            <div style={{ marginBottom: 8 }}>
              <span style={bubble('#fff', '#333')}>
                思考中
                <ThinkingDots />
              </span>
            </div>
          )}
          {cur.streaming && (
            <div style={{ marginBottom: 8 }}>
              <span style={bubble('#fff', '#333')}>
                {cur.streaming}
                <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>
              </span>
            </div>
          )}
          {incompleteTurn && !cur.busy && (
            <div style={{ marginBottom: 8 }}>
              <button
                onClick={resumeMessage}
                title="上次任务未完成，点击继续执行"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 14, border: '1px solid #1677ff', background: '#fff', color: '#1677ff', fontSize: 13, cursor: 'pointer' }}
              >
                <IconRefresh />
                继续执行
              </button>
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
            <div style={{ color: '#555', marginBottom: 10, fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
              {formatArgs(pendingApproval.args)}
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
            {queueCount > 0 && (
              <div style={{ marginBottom: 6, fontSize: 12, color: '#fa8c16', display: 'flex', alignItems: 'center', gap: 4 }}>
                <IconClock />
                排队中 {queueCount} 条消息，将在当前任务完成后自动执行
              </div>
            )}
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
                <div ref={modelMenuRef} style={{ position: 'relative' }}>
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
                            setCustomModelDrawerOpen(true)
                          }}
                          style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px dashed #d9d9d9', background: '#fff', cursor: 'pointer', fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                        >
                          <IconPlus /> 管理自定义模型
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => void pickWorkdir()}
                  title={`工作目录：${workDir || '未设置'}（点击选择目录）`}
                  style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 12, color: '#555', background: '#fff', outline: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 150 }}
                >
                  <IconFolder />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workDirName}</span>
                  <IconEdit />
                </button>
                <button title="操作电脑" onClick={() => void window.shanhai?.screenshot()} style={iconBtn}><IconMonitor /></button>
                <div ref={approvalMenuRef} style={{ position: 'relative' }}>
                  <button
                    onClick={() => setApprovalMenuOpen((v) => !v)}
                    title="安全模式（审批策略）"
                    style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 12, color: approvalPolicy === 'never' ? '#fa8c16' : '#555', background: '#fff', outline: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <IconShield />
                    {approvalPolicy === 'ask' ? '每次询问' : '自动执行'}
                    <IconChevronDown />
                  </button>
                  {approvalMenuOpen && (
                    <div style={{ position: 'absolute', bottom: '110%', left: 0, minWidth: 180, background: '#fff', border: '1px solid #e0e0e0', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 20, padding: 4 }}>
                      <div style={{ padding: '6px 10px', fontSize: 11, color: '#999', fontWeight: 600 }}>安全模式</div>
                      <div
                        onClick={() => switchApprovalPolicy('ask')}
                        style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: approvalPolicy === 'ask' ? '#1677ff' : '#333', background: approvalPolicy === 'ask' ? '#f0f5ff' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                      >
                        <span>每次询问（推荐）</span>
                        {approvalPolicy === 'ask' && <IconCheck />}
                      </div>
                      <div
                        onClick={() => switchApprovalPolicy('never')}
                        style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: approvalPolicy === 'never' ? '#fa8c16' : '#333', background: approvalPolicy === 'never' ? '#fff7e6' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                      >
                        <span>自动执行（不询问）</span>
                        {approvalPolicy === 'never' && <IconCheck />}
                      </div>
                      <div style={{ padding: '4px 10px 6px', fontSize: 10, color: '#bbb', lineHeight: 1.5 }}>
                        「自动执行」下危险操作将不再弹窗确认
                      </div>
                    </div>
                  )}
                </div>
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

        {/* token 用量状态栏（累计 / 本轮 / 上下文占比） */}
        <TokenStatusBar stats={tokenStats} />
      </div>

      {/* 登录弹窗（未登录时点左下角头像弹出；登录态下主界面照常可用） */}
      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} onLogin={handleLogin} />}

      {/* 自定义模型管理：侧边滑出抽屉（列表 + 新增/编辑） */}
      {customModelDrawerOpen && (
        <CustomModelDrawer
          models={customModels}
          onClose={() => setCustomModelDrawerOpen(false)}
          onAdd={handleAddModel}
          onUpdate={handleUpdateModel}
          onRemove={handleRemoveModel}
          onSelect={(id) => {
            setSelectedModel(id)
            void window.shanhai?.switchModel(id)
          }}
        />
      )}

      <style>{`html, body, #root { margin: 0; height: 100%; overflow: hidden; } @keyframes blink { 50% { opacity: 0 } } @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } } @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.35 } 40% { transform: translateY(-3px); opacity: 1 } }`}</style>
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

/** 把工具参数渲染成友好键值对（长字符串截断，避免直接甩 JSON） */
function formatArgs(args: Record<string, unknown> | undefined): React.ReactNode {
  if (!args || Object.keys(args).length === 0) return <span style={{ color: '#999' }}>（无参数）</span>
  const entries = Object.entries(args)
  return (
    <div>
      {entries.map(([k, v]) => (
        <div key={k} style={{ marginBottom: 2 }}>
          <span style={{ color: '#8c8c8c' }}>{k}：</span>
          <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>{prettyValue(v)}</span>
        </div>
      ))}
    </div>
  )
}

function prettyValue(v: unknown): string {
  if (v === null || v === undefined) return '（空）'
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…（共 ${v.length} 字）` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const s = JSON.stringify(v)
    return s.length > 300 ? `${s.slice(0, 300)}…` : s
  } catch {
    return String(v)
  }
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

function IconShield() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
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

function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function IconEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M21 2v6h-6" />
      <path d="M21 8a9 9 0 1 0 2 5" />
    </svg>
  )
}

function IconTerminal() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M4 17l6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  )
}

function IconFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

function IconTree() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M9 10v10" />
    </svg>
  )
}

function IconImage() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
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

/** 思考中提示：三个依次跳动的点 */
function ThinkingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, marginLeft: 4, verticalAlign: 'middle', alignItems: 'flex-end' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: '#999',
            display: 'inline-block',
            animation: `bounce 1.4s ${i * 0.18}s infinite ease-in-out`,
          }}
        />
      ))}
    </span>
  )
}

// Markdown 渲染组件（代码块高亮 / 行内代码 / 链接 / 图片宽度限制）
function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map((c) => (typeof c === 'string' ? c : '')).join('')
  return ''
}

/** 代码块：深色高亮 + 右上角「复制代码」按钮（点击后对勾反馈） */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = extractCodeText(children)
  return (
    <div style={{ position: 'relative', margin: '8px 0' }}>
      <button
        onClick={() => {
          void copyText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }}
        style={{ position: 'absolute', top: 8, right: 8, padding: '2px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#abb2bf', fontSize: 11, cursor: 'pointer', zIndex: 2 }}
      >
        {copied ? '✓ 已复制' : '复制'}
      </button>
      <pre style={{ background: '#282c34', color: '#abb2bf', padding: '12px 12px 12px 12px', borderRadius: 8, overflowX: 'auto', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
        <code style={{ fontFamily: 'ui-monospace, monospace' }}>{children}</code>
      </pre>
    </div>
  )
}

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
    return <CodeBlock>{props.children}</CodeBlock>
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

function SessionRow(props: {
  session: { id: string; title: string; workDir: string }
  active: boolean
  busy: boolean
  editing: boolean
  editingTitle: string
  onTitleChange: (v: string) => void
  onStartEdit: () => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onDelete: () => void
  onSelect: () => void
}) {
  const [hover, setHover] = useState(false)
  const { session: s } = props

  if (props.editing) {
    return (
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #eee', background: props.active ? '#e8f1ff' : 'transparent' }}>
        <input
          value={props.editingTitle}
          onChange={(e) => props.onTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onCommitEdit()
            if (e.key === 'Escape') props.onCancelEdit()
          }}
          autoFocus
          onBlur={props.onCommitEdit}
          style={{ width: '100%', padding: '4px 6px', borderRadius: 6, border: '1px solid #1677ff', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
        />
      </div>
    )
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={props.onSelect}
      style={{
        padding: '8px 12px',
        cursor: 'pointer',
        fontSize: 13,
        color: '#333',
        borderBottom: '1px solid #eee',
        background: props.active ? '#e8f1ff' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={s.title}>
        {s.title}
      </span>
      {props.busy && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1677ff', flexShrink: 0 }} />}
      {(hover || props.active) && (
        <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              props.onStartEdit()
            }}
            title="重命名"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 2, display: 'inline-flex' }}
          >
            <IconEdit />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              props.onDelete()
            }}
            title="删除会话"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 2, display: 'inline-flex' }}
          >
            <IconTrash />
          </button>
        </span>
      )}
    </div>
  )
}

function TokenStatusBar({ stats }: { stats: TokenSnapshot | null }) {
  if (!stats) {
    return <div style={{ padding: '6px 16px', borderTop: '1px solid #eee', background: '#fff', fontSize: 11, color: '#bbb' }}>token 用量统计中…</div>
  }
  const pct = Math.round((stats.contextUsageRatio || 0) * 100)
  return (
    <div style={{ padding: '6px 16px', borderTop: '1px solid #eee', background: '#fff', fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontFamily: 'ui-monospace, monospace' }}>
      <span title="本次启动以来累计 token">
        累计 <b style={{ color: '#555' }}>{fmtTokens(stats.total)}</b>
        <span style={{ color: '#bbb' }}>（入 {fmtTokens(stats.totalPrompt)} / 出 {fmtTokens(stats.totalCompletion)}）</span>
      </span>
      <span title="当前这轮任务消耗的 token">
        本轮 <b style={{ color: '#1677ff' }}>{fmtTokens(stats.turn)}</b>
      </span>
      <span title="当前会话累计完成的任务循环轮次（一次完整的「用户消息 → 最终回复」算一轮）">
        轮次 <b style={{ color: '#1677ff' }}>{stats.turnCount}</b>
      </span>
      <span title="当前会话上下文窗口占用（最近一次请求的 prompt token / 模型上下文长度）" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        上下文
        <span style={{ width: 120, height: 6, borderRadius: 3, background: '#f0f0f0', overflow: 'hidden', display: 'inline-block' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.min(pct, 100)}%`, background: pct > 80 ? '#ff4d4f' : pct > 60 ? '#faad14' : '#1677ff', transition: 'width 0.3s ease' }} />
        </span>
        <b style={{ color: '#555' }}>{pct}%</b>
        <span style={{ color: '#bbb' }}>
          {fmtTokens(stats.lastPrompt)} / {stats.contextLength > 0 ? fmtTokens(stats.contextLength) : '未知'}
        </span>
      </span>
    </div>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 预置服务商（OpenAI 兼容端点）：用户只需选服务商 + 填密钥，baseUrl/模型由服务商预设 */
const MODEL_PROVIDERS: Array<{ id: string; name: string; baseUrl: string; models: string[] }> = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'] },
  { id: 'qwen', name: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'] },
  { id: 'kimi', name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2'] },
  { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', models: ['abab6.5s-chat', 'MiniMax-Text-01'] },
]

/** 根据 baseUrl 反查服务商（编辑已配置模型时回填下拉）；匹配不到返回 undefined */
function inferProvider(baseUrl: string): (typeof MODEL_PROVIDERS)[number] | undefined {
  const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase()
  return MODEL_PROVIDERS.find((p) => norm(p.baseUrl) === norm(baseUrl))
}

function CustomModelDrawer(props: {
  models: GatewayModel[]
  onClose: () => void
  onAdd: (m: { name: string; baseUrl: string; apiKey: string; model: string }) => Promise<void>
  onUpdate: (id: string, m: { name: string; baseUrl: string; apiKey: string; model: string }) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onSelect: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  // 打开时默认选中第一个已配置模型，右侧立即有内容
  useEffect(() => {
    const first = props.models[0]
    if (!first) return
    setEditingId(first.id)
    setName(first.name)
    setBaseUrl(first.baseUrl)
    setApiKey(first.apiKey)
    setModel(first.model ?? first.id)
    setProviderId(inferProvider(first.baseUrl)?.id ?? '')
    setCustomModel(!inferProvider(first.baseUrl)?.models.includes(first.model ?? first.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openAdd(): void {
    setEditingId(null)
    const p = MODEL_PROVIDERS[0]
    if (!p) return
    setProviderId(p.id)
    setName(p.name)
    setBaseUrl(p.baseUrl)
    setModel(p.models[0] ?? '')
    setCustomModel(false)
    setApiKey('')
    setErr('')
  }

  function openEdit(m: GatewayModel): void {
    setEditingId(m.id)
    setName(m.name)
    setBaseUrl(m.baseUrl)
    setApiKey(m.apiKey)
    setModel(m.model ?? m.id)
    const p = inferProvider(m.baseUrl)
    setProviderId(p?.id ?? '')
    setCustomModel(!p || !p.models.includes(m.model ?? m.id))
    setErr('')
  }

  function selectProvider(id: string): void {
    const p = MODEL_PROVIDERS.find((x) => x.id === id)
    if (!p) return
    setProviderId(id)
    setName(p.name)
    setBaseUrl(p.baseUrl)
    setModel(p.models[0] ?? '')
    setCustomModel(false)
    setErr('')
  }

  async function submit(): Promise<void> {
    const finalName = name.trim() || MODEL_PROVIDERS.find((p) => p.id === providerId)?.name || '自定义模型'
    if (!baseUrl || !apiKey.trim() || !model.trim()) {
      setErr('请选择服务商、填写 API Key 与模型')
      return
    }
    setLoading(true)
    setErr('')
    try {
      if (editingId) await props.onUpdate(editingId, { name: finalName, baseUrl, apiKey, model })
      else await props.onAdd({ name: finalName, baseUrl, apiKey, model })
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function remove(): Promise<void> {
    if (!editingId) return
    await props.onRemove(editingId)
    openAdd()
  }

  function useModel(): void {
    if (!editingId) return
    props.onSelect(editingId)
    props.onClose()
  }

  return (
    <div onClick={props.onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 110, fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* 全屏弹窗：左右排版 */}
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '100%', background: '#fff', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>自定义模型</div>
          <button onClick={props.onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#999', padding: 4, display: 'inline-flex' }}>
            <IconClose />
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 左侧：已配置模型列表 */}
          <aside style={{ width: 280, borderRight: '1px solid #eee', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
            <div style={{ padding: '12px 12px 8px', fontSize: 12, color: '#999', fontWeight: 600 }}>已配置模型</div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
              {props.models.length === 0 ? (
                <div style={{ padding: '40px 12px', textAlign: 'center', color: '#bbb', fontSize: 13 }}>
                  还没有自定义模型
                  <br />
                  点击下方按钮新增
                </div>
              ) : (
                props.models.map((m) => (
                  <div
                    key={m.id}
                    onClick={() => openEdit(m)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      marginBottom: 6,
                      cursor: 'pointer',
                      background: editingId === m.id ? '#e8f1ff' : '#fff',
                      border: editingId === m.id ? '1px solid #1677ff' : '1px solid #eee',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                      model: {m.model ?? m.id}
                    </div>
                    <div style={{ fontSize: 11, color: '#bbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.baseUrl}</div>
                  </div>
                ))
              )}
            </div>
            <div style={{ padding: '12px', borderTop: '1px solid #eee' }}>
              <button onClick={openAdd} style={{ width: '100%', padding: '10px', borderRadius: 8, border: '1px dashed #d9d9d9', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <IconPlus /> 新增自定义模型
              </button>
            </div>
          </aside>

          {/* 右侧：选中模型的配置编辑区域 */}
          <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 16 }}>
              {editingId ? '编辑自定义模型' : '新增自定义模型'}
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>服务商</div>
              <select
                value={providerId}
                onChange={(e) => selectProvider(e.target.value)}
                style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, boxSizing: 'border-box', outline: 'none', background: '#fff' }}
              >
                {!MODEL_PROVIDERS.some((p) => p.id === providerId) && <option value="">自定义端点</option>}
                {MODEL_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <Field label="名称" value={name} onChange={setName} placeholder="例如：我的 GPT-4o" />
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>模型</div>
              <select
                value={customModel ? '__custom__' : model}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '__custom__') {
                    setCustomModel(true)
                    return
                  }
                  setCustomModel(false)
                  setModel(v)
                }}
                style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, boxSizing: 'border-box', outline: 'none', background: '#fff', marginBottom: 6 }}
              >
                {(MODEL_PROVIDERS.find((p) => p.id === providerId)?.models ?? [model]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom__">其他（自定义）…</option>
              </select>
              {customModel && (
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="输入模型名，如 gpt-4o"
                  style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid #ddd', fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
                />
              )}
            </div>
            <Field label="API Key" value={apiKey} onChange={setApiKey} placeholder="sk-..." password />
            <div style={{ fontSize: 11, color: '#bbb', marginBottom: 12, wordBreak: 'break-all' }}>端点：{baseUrl || '（未选择服务商）'}</div>
            {err && <p style={{ color: '#ff4d4f', fontSize: 12, marginBottom: 8, wordBreak: 'break-word' }}>{err}</p>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => void submit()} disabled={loading} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#1677ff', color: '#fff', fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
                {loading ? '保存中…' : '保存'}
              </button>
              {editingId && (
                <>
                  <button onClick={useModel} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #1677ff', background: '#fff', color: '#1677ff', fontSize: 14, cursor: 'pointer' }}>
                    使用此模型
                  </button>
                  <button onClick={() => void remove()} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #ffccc7', background: '#fff', color: '#ff4d4f', fontSize: 14, cursor: 'pointer' }}>
                    删除
                  </button>
                </>
              )}
              <button onClick={props.onClose} style={{ marginLeft: 'auto', padding: '10px 16px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 14, cursor: 'pointer' }}>
                关闭
              </button>
            </div>
          </main>
        </div>
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

// ===== 消息操作（复制 / 重新发送）=====

/** 把文本写入剪贴板（navigator.clipboard 优先，失败回退 execCommand） */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

interface MessageAction {
  key: string
  icon: React.ReactNode
  label: string
  run: () => void | Promise<void>
}

/** 消息图标操作行（参考 taco 的 msg-actions：常显在气泡下方，图标按钮 + 点击后对勾反馈） */
function MessageActions({ actions }: { actions: MessageAction[] }) {
  const [done, setDone] = useState<string | null>(null)
  return (
    <div style={{ display: 'flex', gap: 2, marginTop: 4, opacity: 0.85, transition: 'opacity .15s' }}>
      {actions.map((a) => (
        <button
          key={a.key}
          title={a.label}
          onClick={() => {
            try {
              void a.run()
            } catch {
              /* 忽略复制失败 */
            }
            setDone(a.key)
            window.setTimeout(() => setDone((v) => (v === a.key ? null : v)), 1000)
          }}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: done === a.key ? '#1677ff' : '#999', cursor: 'pointer', padding: 0 }}
        >
          {done === a.key ? <IconCheck /> : a.icon}
        </button>
      ))}
    </div>
  )
}

/** 用户消息气泡：右对齐，气泡下方常显「编辑 / 复制 / 重新发送」；编辑为内联编辑（Enter 确认 / Esc 取消，参考 taco） */
function UserMessage({ content, images, userIndex, busy, onResend, onEditResend }: {
  content: string
  images?: string[]
  userIndex: number
  busy: boolean
  onResend: (userIndex: number) => void
  onEditResend: (userIndex: number, newContent: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)

  const confirmEdit = (): void => {
    const text = draft.trim()
    setEditing(false)
    if (text && text !== content) onEditResend(userIndex, text)
  }

  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      {images?.map((img, j) => (
        <img key={j} src={img} alt="附件" style={{ maxWidth: 200, maxHeight: 200, borderRadius: 8, display: 'block', marginBottom: 4, objectFit: 'cover' }} />
      ))}
      {editing ? (
        <div style={{ width: '100%', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                confirmEdit()
              } else if (e.key === 'Escape') {
                setEditing(false)
                setDraft(content)
              }
            }}
            autoFocus
            rows={3}
            style={{ width: '100%', padding: '8px 14px', borderRadius: 12, border: '1px solid #1677ff', fontSize: 14, lineHeight: 1.6, resize: 'none', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', background: '#fff', color: '#333', display: 'block' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#999' }}>
            <span>Enter 确认 · Esc 取消</span>
            <button onClick={confirmEdit} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: '#1677ff', color: '#fff', fontSize: 12, cursor: 'pointer' }}>确认</button>
            <button onClick={() => { setEditing(false); setDraft(content) }} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 12, cursor: 'pointer' }}>取消</button>
          </div>
        </div>
      ) : content ? (
        <>
          <div style={{ maxWidth: '70%', padding: '8px 14px', borderRadius: 16, borderBottomRightRadius: 4, background: '#1677ff', color: '#fff', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            {content}
          </div>
          {!busy && (
            <MessageActions
              actions={[
                { key: 'edit', icon: <IconEdit />, label: '编辑', run: () => { setEditing(true); setDraft(content) } },
                { key: 'copy', icon: <IconCopy />, label: '复制', run: () => copyText(content) },
                { key: 'resend', icon: <IconRefresh />, label: '重新发送', run: () => onResend(userIndex) },
              ]}
            />
          )}
        </>
      ) : null}
    </div>
  )
}

/** AI 助手消息卡片：左对齐，气泡下方固定显示「复制」图标操作 */
function AssistantMessage({ content }: { content: string }) {
  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <div style={{ maxWidth: '85%', padding: '10px 14px', borderRadius: 16, borderTopLeftRadius: 4, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.06)', fontSize: 14, lineHeight: 1.65, color: '#333', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      </div>
      <MessageActions
        actions={[{ key: 'copy', icon: <IconCopy />, label: '复制', run: () => copyText(content) }]}
      />
    </div>
  )
}

function IconError() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  )
}

// ===== 工具调用渲染（参考 DSH ToolRow / Codex：单行摘要 + 类型卡片，不显示 JSON）=====

/** 工具名 → 人类可读的中文标题 + 图标（原始工具名对普通人不可读） */
const TOOL_META: Record<string, { title: string; icon: React.ReactNode }> = {
  read_file: { title: '读取文件', icon: <IconFile /> },
  write_file: { title: '写入文件', icon: <IconEdit /> },
  run_command: { title: '执行命令', icon: <IconTerminal /> },
  list_dir: { title: '列出目录', icon: <IconTree /> },
  image_analyze: { title: '识别图片', icon: <IconImage /> },
  computer_screenshot: { title: '屏幕截图', icon: <IconMonitor /> },
  computer_ocr: { title: '文字识别', icon: <IconMonitor /> },
  computer_action: { title: '电脑操作', icon: <IconMonitor /> },
}

/** 从工具参数提取一行摘要（读/写 → 路径，命令 → 命令，列目录 → 路径，电脑操作 → 动作） */
function toolSummary(name: string, args?: Record<string, unknown>): string {
  if (!args) return ''
  const a = args
  if (name === 'read_file' || name === 'write_file') return String(a.path ?? '')
  if (name === 'run_command') return String(a.command ?? '')
  if (name === 'list_dir') return a.path ? String(a.path) : '当前目录'
  if (name === 'image_analyze') return String(a.imageUrl ?? '').slice(0, 48)
  if (name === 'computer_action') return String(a.action ?? '')
  if (name === 'computer_screenshot' || name === 'computer_ocr') return ''
  return ''
}

/** 脱敏：把 token / api key / 密码等敏感字段替换为 ***，避免泄露 */
function redactSecret(text: string): string {
  return text
    .replace(/((?:token|api[_-]?key|access_token|authorization|bearer|password|passwd|pwd|secret)\s*[:=]\s*)([^\s'"]+)/gi, '$1***')
    .replace(/(bearer\s+)([a-zA-Z0-9._-]+)/gi, '$1***')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…（共 ${text.length} 字）`
}

/** 终端结果卡片：命令 + stdout/stderr（深色终端样式） */
function TerminalBlock({ command, stdout, stderr }: { command: string; stdout: string; stderr: string }) {
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {command && (
        <div style={{ padding: '8px 12px', background: '#282c34', color: '#61afef', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <span style={{ color: '#7f848e' }}>$ </span>
          {command}
        </div>
      )}
      {(stdout || stderr) && (
        <div style={{ padding: '8px 12px', background: '#1e1e1e', color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 280, overflowY: 'auto' }}>
          {stdout}
          {stderr && <span style={{ color: '#f48771' }}>{stderr}</span>}
        </div>
      )}
    </div>
  )
}

/** 文件结果卡片：带行号的只读文件窗口（超长折叠） */
function FileBlock({ content, path }: { content: string; path?: string }) {
  const lines = content.split('\n')
  const MAX = 200
  const shown = lines.slice(0, MAX)
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {path && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid #f0f0f0', color: '#999', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {path} · {lines.length} 行
        </div>
      )}
      <div style={{ maxHeight: 320, overflowY: 'auto', padding: '4px 0' }}>
        {shown.map((line, i) => (
          <div key={i} style={{ display: 'flex', padding: '0 0' }}>
            <span style={{ width: 40, textAlign: 'right', paddingRight: 10, color: '#bbb', flexShrink: 0, userSelect: 'none' }}>{i + 1}</span>
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1, color: '#444' }}>{line || ' '}</span>
          </div>
        ))}
        {lines.length > MAX && (
          <div style={{ color: '#999', padding: '6px 12px', fontSize: 11 }}>… 共 {lines.length} 行，仅显示前 {MAX} 行</div>
        )}
      </div>
    </div>
  )
}

/** 按工具类型渲染结果卡片（read → 文件行号 / run_command → 终端 / list_dir → 树形 / 截图 → 图片 / 其他 → 纯文本脱敏） */
function renderToolResult(name: string, result: unknown, error: string | undefined, args?: Record<string, unknown>): React.ReactNode | null {
  if (error) {
    return (
      <div style={{ padding: '10px 12px', color: '#cf1322', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
        {redactSecret(error)}
      </div>
    )
  }
  if (result === undefined || result === null) return null
  if (name === 'run_command') {
    const r = result as { stdout?: string; stderr?: string }
    return <TerminalBlock command={String(args?.command ?? '')} stdout={r.stdout ?? ''} stderr={r.stderr ?? ''} />
  }
  if (name === 'list_dir') {
    return (
      <pre style={{ margin: 0, padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, color: '#444', whiteSpace: 'pre', overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
        {String(result)}
      </pre>
    )
  }
  if (name === 'read_file') {
    return <FileBlock content={String(result)} path={String(args?.path ?? '')} />
  }
  if (name === 'computer_screenshot') {
    const src = String(result)
    return src ? <img src={src} alt="截图" style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : null
  }
  if (name === 'write_file') {
    const r = result as { ok?: boolean; path?: string }
    return <div style={{ padding: '10px 12px', color: '#389e0d', fontSize: 12 }}>✓ 已写入 {r.path ?? ''}</div>
  }
  return (
    <pre style={{ margin: 0, padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, color: '#444', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto' }}>
      {redactSecret(truncate(String(result), 4000))}
    </pre>
  )
}

/** 工具执行步骤（DSH ToolRow 风格）：单行摘要（中文标题 + 摘要）+ 折叠的类型卡片 */
function ToolStep({ trace }: { trace: ToolTrace }) {
  const [expanded, setExpanded] = useState(false)
  const isCall = trace.kind === 'tool-call'
  const meta = TOOL_META[trace.name] ?? { title: trace.name, icon: <IconWrench /> }
  const state = isCall ? 'running' : trace.error ? 'error' : 'ok'
  const summary = toolSummary(trace.name, trace.args)
  const resultBody = !isCall ? renderToolResult(trace.name, trace.result, trace.error, trace.args) : null
  const expandable = resultBody !== null
  const stateColor = state === 'error' ? '#cf1322' : state === 'running' ? '#1677ff' : '#389e0d'

  return (
    <div style={{ marginBottom: 6, fontSize: 13 }}>
      <div
        onClick={() => expandable && setExpanded((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 8, background: '#fff', border: '1px solid #f0f0f0', cursor: expandable ? 'pointer' : 'default', maxWidth: '85%', boxSizing: 'border-box' }}
      >
        <span style={{ color: stateColor, display: 'inline-flex', flexShrink: 0 }}>{meta.icon}</span>
        <b style={{ fontWeight: 600, color: '#333', fontSize: 13, flexShrink: 0 }}>{meta.title}</b>
        {summary && (
          <>
            <span style={{ color: '#d9d9d9', flexShrink: 0 }}>·</span>
            <span style={{ color: '#8c8c8c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{summary}</span>
          </>
        )}
        {state === 'running' && <span style={{ color: '#1677ff', fontSize: 12, flexShrink: 0 }}>执行中…</span>}
        {isCall && trace.approvalRequired && (
          <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#fffbe6', color: '#d48806', border: '1px solid #ffe58f', flexShrink: 0 }}>待确认</span>
        )}
        {expandable && (
          <span style={{ marginLeft: 'auto', color: '#bbb', display: 'inline-flex', flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
            <IconChevronDown />
          </span>
        )}
      </div>
      {expanded && expandable && (
        <div style={{ marginLeft: 20, marginTop: 4, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa', overflow: 'hidden' }}>
          {resultBody}
        </div>
      )}
    </div>
  )
}
