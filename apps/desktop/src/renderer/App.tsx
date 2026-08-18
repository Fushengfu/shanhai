import * as React from 'react'
import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toPng } from 'html-to-image'

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
  turnCachedPromptTokens: number
  totalCachedPromptTokens: number
  cacheHitRatio: number
  turnCount: number
}

type HistoryItem =
  | { kind: 'user'; content?: string; attachments?: unknown[] }
  | { kind: 'assistant'; content?: string; reasoningContent?: string }
  | { kind: 'tool'; trace?: ToolTrace }

/** 自修改（K5）browser 半投递的 round-trip 审批请求 */
interface ClientRunRequest {
  requestId: string
  sessionId: string
  pkgId: string
  name: string
  purpose: string
}

/** 多专家编排轨迹（Triage 拆解 → 专家执行过程） */
interface ExpertTrace {
  sessionId?: string
  stepId: string
  expertId: string
  expertName: string
  title: string
  status: 'started' | 'completed' | 'failed'
  result?: string
  error?: string
}

/** 动态注册到 UI 插槽的组件（browser 半 slots.register 的产物） */
interface ClientComponentReg {
  slot: string
  id: string
  pkgId: string
  Component: React.ComponentType
}

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
      saveUploadedFile(fileName: string, dataBase64: string): Promise<string>
      listBrowserWindows(sessionId?: string): Promise<Array<{ appId: string; url: string; title: string; label?: string }>>
      showBrowserWindow(appId: string): Promise<void>
      closeBrowserWindow(appId: string): Promise<void>
      selectDirectory(defaultPath?: string): Promise<string | null>
      getSessionHistory(id?: string): Promise<HistoryItem[]>
      getSessionTrace(id?: string): Promise<Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoningContent?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>; toolCallId?: string; turn: number; timestamp: number }>>
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
      onReasoning(cb: (sessionId: string, text: string) => void): () => void
      switchModel(id: string): Promise<void>
      getCurrentModelId(): Promise<string>
      stop(): Promise<void>
      speak(text: string): Promise<void>
      getTokenStats(): Promise<TokenSnapshot>
      onTokenStats(cb: (sessionId: string, stats: TokenSnapshot) => void): () => void
      selfmodInspect(sessionId?: string): Promise<unknown>
      onClientRunRequest(cb: (req: ClientRunRequest) => void): () => void
      respondClientRun(requestId: string, approved: boolean): Promise<void>
      onClientCode(cb: (payload: { pkgId: string; name: string; code: string }) => void): () => void
      onClientRemove(cb: (pkgId: string) => void): () => void
      onExpertTrace(cb: (trace: ExpertTrace) => void): () => void
    }
  }
}

type ChatItem =
  | { kind: 'user'; content: string; images?: string[] }
  | { kind: 'assistant'; content: string; reasoningContent?: string }
  | { kind: 'tool'; trace: ToolTrace }

/** 每个会话独立的 UI 状态（支持并行会话：切换会话后，后台会话继续跑，互不串扰） */
interface SessionUIState {
  items: ChatItem[]
  streaming: string
  streamingReasoning: string
  busy: boolean
}

const EMPTY_SESSION: SessionUIState = { items: [], streaming: '', streamingReasoning: '', busy: false }

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
  const [tracePanelOpen, setTracePanelOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const modelMenuRef = useRef<HTMLDivElement>(null)
  // token 用量按会话隔离：每个会话独立的累计/本轮/上下文/缓存命中统计
  const [tokenStatsBySession, setTokenStatsBySession] = useState<Record<string, TokenSnapshot>>({})
  const [attachments, setAttachments] = useState<Array<{ type: 'image' | 'audio' | 'video' | 'file'; name: string; dataUrl: string; mime: string; size: number }>>([])
  // 当前会话打开的浏览器窗口（agent 自主打开，标签区展示，可手动关闭）
  const [browserWindows, setBrowserWindows] = useState<Array<{ appId: string; url: string; title: string; label?: string }>>([])
  const fileRef = useRef<HTMLInputElement>(null)
  // 图片预览：点击输入框/聊天历史里的图片放大查看（遮罩层，点击或 Esc 关闭）
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  // 审批请求按会话隔离：每个会话一个队列，弹窗只显示当前会话的待审批请求（并行会话互不串扰）
  const [approvalQueues, setApprovalQueues] = useState<Record<string, ApprovalRequest[]>>({})
  // 跟踪当前会话 id（供审批回调等闭包读取最新值，避免捕获旧 state）
  const currentSessionIdRef = useRef('')
  // 每个会话的输入框草稿（输入到一半切换会话，切回来草稿不丢）
  const draftRef = useRef<Record<string, { input: string; attachments: Array<{ type: 'image' | 'audio' | 'video' | 'file'; name: string; dataUrl: string; mime: string; size: number }> }>>({})
  const [input, setInput] = useState('')
  // 输入法组合中标记：中文等 IME 用回车选词时不应触发发送（keydown 时 isComposing 为 true）
  const isComposingRef = useRef(false)
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
  // 自修改（K5）：browser 半动态注册的 UI 组件（按 slot 分组）
  const [clientComponents, setClientComponents] = useState<Record<string, ClientComponentReg[]>>({})
  // 自修改（K5）：browser 半投递的 round-trip 审批请求队列（按会话隔离）
  const [clientRunRequests, setClientRunRequests] = useState<Record<string, ClientRunRequest[]>>({})
  // 每个动态包的 browser 半 disposer（factory 返回值），卸载时调用
  const clientDisposers = useRef<Map<string, () => void>>(new Map())
  // 多专家编排轨迹（按会话隔离：Triage 拆解 → 专家执行过程）
  const [expertTraces, setExpertTraces] = useState<Record<string, ExpertTrace[]>>({})

  const cur = sessionMap[currentSessionId] ?? EMPTY_SESSION
  // 当前会话的待审批请求（会话级隔离：只显示当前会话队列的头一个，并行会话互不串扰）
  const curApproval = (approvalQueues[currentSessionId] ?? [])[0] ?? null
  // 当前会话的 browser 半投递审批请求
  const curClientRunRequest = (clientRunRequests[currentSessionId] ?? [])[0] ?? null
  // 当前会话的多专家编排轨迹
  const curExpertTraces = expertTraces[currentSessionId] ?? []

  /** 执行 browser 半代码：注入 React + slots（按 pkgId 隔离），注册动态组件到指定 slot */
  const mountClientCode = (pkgId: string, code: string): void => {
    try {
      const slotsForPkg = {
        register: (reg: { slot: string; id: string; component: React.ComponentType }) => {
          const fullId = `${pkgId}:${reg.id}`
          setClientComponents((prev) => {
            const list = prev[reg.slot] ?? []
            return { ...prev, [reg.slot]: [...list.filter((x) => x.id !== fullId), { slot: reg.slot, id: fullId, pkgId, Component: reg.component }] }
          })
          return () => {
            setClientComponents((prev) => {
              const list = (prev[reg.slot] ?? []).filter((x) => x.id !== fullId)
              return { ...prev, [reg.slot]: list }
            })
          }
        },
      }
      const factory = new Function('React', 'slots', code) as (ReactNs: typeof React, slots: unknown) => unknown
      const disposer = factory(React, slotsForPkg)
      if (typeof disposer === 'function') clientDisposers.current.set(pkgId, disposer as () => void)
    } catch (err) {
      console.error('[selfmod] browser 半代码执行失败:', err)
    }
  }

  /** 卸载某个动态包：调用其 browser 半 disposer + 移除其注册的所有组件 */
  const unmountClientCode = (pkgId: string): void => {
    const disposer = clientDisposers.current.get(pkgId)
    try {
      disposer?.()
    } catch (err) {
      console.error('[selfmod] browser 半 disposer 失败:', err)
    }
    clientDisposers.current.delete(pkgId)
    setClientComponents((prev) => {
      const next = { ...prev }
      for (const slot of Object.keys(next)) {
        const list = next[slot]
        if (list) next[slot] = list.filter((x) => x.pkgId !== pkgId)
      }
      return next
    })
  }

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
    const offReasoning = api.onReasoning((sessionId, text) => {
      patchSession(sessionId, (s) => ({ streamingReasoning: s.streamingReasoning + text }))
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
      // 浏览器工具执行后同步窗口标签（agent 打开/关闭窗口 → 标签区实时刷新）
      if (trace.name?.startsWith('browser_')) {
        void window.shanhai?.listBrowserWindows(trace.sessionId).then((wins) => setBrowserWindows(wins ?? [])).catch(() => undefined)
      }
    })
    const offApproval = api.onApprovalRequest((req) => {
      // 审批请求按 sessionId 路由到对应会话队列，只影响发起审批的会话，不串扰当前会话
      const sid = req.sessionId ?? currentSessionIdRef.current
      if (!sid) return
      setApprovalQueues((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), req] }))
    })
    const offToken = api.onTokenStats((sessionId, s) => setTokenStatsBySession((prev) => ({ ...prev, [sessionId]: s })))
    // 自修改（K5）：browser 半投递审批 + 代码投递 + 卸载
    const offClientRun = api.onClientRunRequest((req) => {
      const sid = req.sessionId ?? currentSessionIdRef.current
      if (!sid) return
      setClientRunRequests((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), req] }))
    })
    const offClientCode = api.onClientCode((payload) => {
      mountClientCode(payload.pkgId, payload.code)
    })
    const offClientRemove = api.onClientRemove((pkgId) => {
      unmountClientCode(pkgId)
    })
    // 多专家编排轨迹（按 sessionId 路由，started 追加、completed/failed 更新）
    const offExpertTrace = api.onExpertTrace((trace) => {
      const sid = trace.sessionId ?? currentSessionIdRef.current
      if (!sid) return
      setExpertTraces((prev) => {
        const list = prev[sid] ?? []
        const idx = list.findIndex((t) => t.stepId === trace.stepId)
        if (idx >= 0) {
          const next = [...list]
          next[idx] = { ...next[idx], ...trace }
          return { ...prev, [sid]: next }
        }
        return { ...prev, [sid]: [...list, trace] }
      })
    })
    void api.getApprovalPolicy().then((p) => setApprovalPolicyState(p)).catch(() => undefined)
    return () => {
      offDelta()
      offReasoning()
      offTrace()
      offApproval()
      offToken()
      offClientRun()
      offClientCode()
      offClientRemove()
      offExpertTrace()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchSession])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [cur.items, cur.streaming, curApproval])

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
    // 同步清掉该会话的待审批队列和输入框草稿（后端 deleteSession 也会拒绝其 pending 审批）
    setApprovalQueues((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    delete draftRef.current[id]
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

  /** 刷新当前会话的浏览器窗口列表（会话级隔离，agent 打开/关闭窗口后同步到标签区） */
  async function refreshBrowserWindows(sessionId?: string): Promise<void> {
    const sid = sessionId ?? currentSessionId ?? ''
    const wins = (await window.shanhai?.listBrowserWindows(sid)) ?? []
    setBrowserWindows(wins)
  }

  /** 点击标签：显示并聚焦对应浏览器窗口（恢复被遮挡/最小化的窗口） */
  async function showBrowserWindow(appId: string): Promise<void> {
    await window.shanhai?.showBrowserWindow(appId)
  }

  /** 手动关闭一个浏览器窗口 */
  async function closeBrowserWindow(appId: string): Promise<void> {
    await window.shanhai?.closeBrowserWindow(appId)
    void refreshBrowserWindows()
  }

  async function switchToSession(id: string): Promise<void> {
    // 保存当前会话输入框草稿，切回来不丢
    if (currentSessionId) {
      draftRef.current[currentSessionId] = { input, attachments }
    }
    setCurrentSessionId(id)
    currentSessionIdRef.current = id
    // 恢复目标会话草稿（若有），否则清空输入框
    const draft = draftRef.current[id]
    setInput(draft?.input ?? '')
    setAttachments(draft?.attachments ?? [])
    await window.shanhai?.switchSession(id)
    // 会话级审批策略：切到该会话时同步其安全模式到 UI
    void window.shanhai?.getApprovalPolicy().then((p) => setApprovalPolicyState(p)).catch(() => undefined)
    // 会话级 token 统计：切会话后拉取该会话的用量（底部状态栏隔离）
    void window.shanhai?.getTokenStats().then((s) => setTokenStatsBySession((prev) => ({ ...prev, [id]: s }))).catch(() => undefined)
    // 会话级浏览器窗口：切会话后同步该会话打开的浏览器窗口到标签区
    void refreshBrowserWindows(id)
    // 检查是否有未完成的消息（决定是否显示「继续执行」按钮）
    const incomplete = (await window.shanhai?.hasIncompleteTurn(id)) ?? false
    setIncompleteTurn(incomplete)
    setQueueCount(pendingQueue.current[id]?.length ?? 0)
    if (loadedSessions.current.has(id)) return
    loadedSessions.current.add(id)
    const history = (await window.shanhai?.getSessionHistory(id)) ?? []
    const items = historyToItems(history)
    patchSession(id, { items, streaming: '', streamingReasoning: '', busy: false })
  }

  async function createSession(): Promise<void> {
    const id = await window.shanhai?.createSession()
    if (!id) return
    loadedSessions.current.add(id)
    patchSession(id, { items: [], streaming: '', streamingReasoning: '', busy: false })
    // 保存当前会话草稿，新建会话输入框清空
    if (currentSessionId) {
      draftRef.current[currentSessionId] = { input, attachments }
    }
    setCurrentSessionId(id)
    currentSessionIdRef.current = id
    setInput('')
    setAttachments([])
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
    patchSession(sid, (s) => ({ items: [...s.items, { kind: 'user', content: text, images }], streaming: '', streamingReasoning: '', busy: true }))
    try {
      const result = (await window.shanhai?.run(text, parts)) ?? ''
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: result }] }))
    } catch (err) {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }] }))
    } finally {
      patchSession(sid, { streaming: '', streamingReasoning: '', busy: false })
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
    const parts: ContentPart[] = []
    const fileNotes: string[] = []
    for (const a of attachments) {
      if (a.type === 'image') {
        parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
        continue
      }
      if (a.type === 'file') {
        // 普通文件：保存到会话工作目录，让 agent 用 read_file 读取（不塞进多模态消息，避免请求体膨胀）
        const base64 = a.dataUrl.replace(/^data:[^;]+;base64,/, '')
        try {
          const savedPath = (await window.shanhai?.saveUploadedFile(a.name, base64)) ?? a.name
          fileNotes.push(`${a.name}（${formatBytes(a.size)}）→ ${savedPath}`)
        } catch {
          fileNotes.push(`${a.name}（${formatBytes(a.size)}）`)
        }
        continue
      }
      // audio / video
      const m = /^data:([^;]+);base64,(.+)$/.exec(a.dataUrl)
      const mime = m?.[1] ?? ''
      const data = m?.[2] ?? ''
      const format = mime.split('/')[1] ?? ''
      parts.push(
        a.type === 'audio'
          ? { type: 'input_audio', input_audio: { data, format } }
          : { type: 'input_video', input_video: { data, format } },
      )
    }
    // 文件说明拼进消息文本（agent 据此 read_file 读取工作目录里的文件）
    const finalText = fileNotes.length > 0 ? `${text}${text ? '\n\n' : ''}[已附加文件]\n${fileNotes.join('\n')}` : text
    setInput('')
    setAttachments([])
    delete draftRef.current[sid]
    if (cur.busy) {
      // 当前任务执行中：新消息进入队列，任务完成后自动执行（队列模式，不丢弃）
      pendingQueue.current[sid] = [...(pendingQueue.current[sid] ?? []), { text: finalText, parts, images }]
      setQueueCount(pendingQueue.current[sid].length)
      return
    }
    void doRun(sid, finalText, parts, images)
  }

  async function respondApproval(outcome: 'allowed-once' | 'rejected'): Promise<void> {
    // 只响应当前会话队列的头一个待审批请求（会话级隔离）
    const sid = currentSessionId
    const req = (approvalQueues[sid] ?? [])[0]
    if (!req) return
    await window.shanhai?.respondApproval(outcome, req.id)
    setApprovalQueues((prev) => {
      const q = (prev[sid] ?? []).slice(1)
      const next = { ...prev }
      if (q.length > 0) next[sid] = q
      else delete next[sid]
      return next
    })
  }

  /** 应答 browser 半投递审批（自修改 K5：用户 approve 才投递界面） */
  async function respondClientRun(approved: boolean): Promise<void> {
    const sid = currentSessionId
    const req = (clientRunRequests[sid] ?? [])[0]
    if (!req) return
    await window.shanhai?.respondClientRun(req.requestId, approved)
    setClientRunRequests((prev) => {
      const q = (prev[sid] ?? []).slice(1)
      const next = { ...prev }
      if (q.length > 0) next[sid] = q
      else delete next[sid]
      return next
    })
  }

  /** 重新发送：截断到该用户消息重新生成（对齐 taco 的 resendFromExisting，直接重发，不填回输入框） */
  function resendMessage(userIndex: number): void {
    const sid = currentSessionId
    if (!sid) return
    // 立即进入繁忙态（发送按钮变「停止」），截断重跑期间保持可中断
    patchSession(sid, (s) => ({ ...s, busy: true, streaming: '', streamingReasoning: '' }))
    // 先从前端视图移除该消息及其后的回复，再走后端截断 + 重跑
    void window.shanhai?.resend(sid, userIndex).then((result) => {
      patchSession(sid, (s) => {
        // 前端重新加载历史，拿到截断后的最新状态
        return { items: s.items, streaming: '', streamingReasoning: '', busy: false }
      })
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }], streaming: '', streamingReasoning: '', busy: false }))
    })
  }

  /** 编辑后重发：截断到该消息，用新内容重新生成 */
  function editResend(userIndex: number, newContent: string): void {
    const sid = currentSessionId
    if (!sid) return
    patchSession(sid, (s) => ({ ...s, busy: true, streaming: '', streamingReasoning: '' }))
    void window.shanhai?.resend(sid, userIndex, newContent).then((result) => {
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }], streaming: '', streamingReasoning: '', busy: false }))
    })
  }

  /** 继续执行：把最后一条未完成的用户消息重新生成（断点恢复） */
  function resumeMessage(): void {
    const sid = currentSessionId
    if (!sid) return
    patchSession(sid, (s) => ({ ...s, busy: true, streaming: '', streamingReasoning: '' }))
    void window.shanhai?.resume(sid).then((result) => {
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }], streaming: '', streamingReasoning: '', busy: false }))
    })
  }

  /** 从后端重新拉取会话历史，刷新前端视图（重发/编辑/续跑后截断状态与后端对齐） */
  async function reloadSessionItems(sid: string, _result: string): Promise<void> {
    const history = (await window.shanhai?.getSessionHistory(sid)) ?? []
    patchSession(sid, { items: historyToItems(history), streaming: '', streamingReasoning: '', busy: false })
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
            : 'file'
      const dataUrl = await readFileAsDataUrl(file)
      setAttachments((prev) => [...prev, { type, name: file.name, dataUrl, mime: file.type, size: file.size }])
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
          setAttachments((prev) => [...prev, { type: 'image', name: `pasted-${Date.now()}.png`, dataUrl, mime: file.type || 'image/png', size: file.size }])
        }
      }
    }
  }

  // 空状态：当前会话还没有任何消息（新建会话 / 首次使用默认会话）
  const isEmpty = cur.items.length === 0

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
          <button
            onClick={() => setTracePanelOpen(true)}
            title="查看执行轨迹"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid #eee', background: '#fff', color: '#666', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
          >
            <IconActivity />
            轨迹
          </button>
        </header>

        {/* 浏览器窗口标签条：当前会话 agent 打开的内置浏览器窗口（放聊天界面顶部，不影响窗口拖动） */}
        {browserWindows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '8px 16px', borderBottom: '1px solid #eee', background: '#fff', flexShrink: 0 } as React.CSSProperties}>
            <span style={{ fontSize: 11, color: '#999', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <IconMonitor />
              浏览器
            </span>
            {browserWindows.map((w) => (
              <div
                key={w.appId}
                onClick={() => void showBrowserWindow(w.appId)}
                title={w.label || w.title || w.url}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, border: '1px solid #e0e0e0', background: '#fafafa', fontSize: 12, color: '#333', maxWidth: 240, cursor: 'pointer' }}
              >
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#52c41a', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {w.label || w.title || w.url || w.appId}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeBrowserWindow(w.appId)
                  }}
                  title="关闭浏览器窗口"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#999', fontSize: 14, padding: 0, lineHeight: 1, flexShrink: 0 }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 消息区：空状态居中显示欢迎信息（输入框也居中），非空显示消息列表并滚动 */}
        <div
          ref={listRef}
          style={
            isEmpty
              ? { flex: '0 0 auto', minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 16px 4px', overflow: 'hidden' }
              : { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 16, background: '#fafafa' }
          }
        >
          {isEmpty ? (
            <WelcomeHero onSuggestion={setInput} />
          ) : (
            <>
          {(() => {
            let userIdx = 0
            return cur.items.map((it, i) => {
              if (it.kind === 'user') {
                const idx = userIdx++
                return <UserMessage key={i} content={it.content} images={it.images} userIndex={idx} busy={cur.busy} onResend={resendMessage} onEditResend={editResend} onPreviewImage={(url) => setPreviewImage(url)} />
              }
              if (it.kind === 'assistant') {
                return <AssistantMessage key={i} content={it.content} reasoningContent={it.reasoningContent} onPreviewImage={(url) => setPreviewImage(url)} />
              }
              // 工具过程（按类型渲染：调用 / 完成 / 出错，点击展开查看详情）
              const t = it.trace
              return <ToolStep key={i} trace={t} />
            })
          })()}
          {cur.busy && !cur.streaming && (
            <div style={{ marginBottom: 8 }}>
              {cur.streamingReasoning ? (
                <ReasoningBlock content={cur.streamingReasoning} streaming />
              ) : (
                <span style={bubble('#fff', '#333')}>
                  思考中
                  <ThinkingDots />
                </span>
              )}
            </div>
          )}
          {cur.streaming && (
            <div style={{ marginBottom: 8 }}>
              {cur.streamingReasoning && <ReasoningBlock content={cur.streamingReasoning} />}
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
            </>
          )}
          {/* 多专家编排轨迹（Triage 拆解 → 专家执行过程，started → completed/failed） */}
          {curExpertTraces.length > 0 && (
            <div style={{ marginBottom: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid #e6d7ff', background: '#faf7ff', fontSize: 12 }}>
              <div style={{ fontWeight: 600, color: '#5b3b8e', marginBottom: 6 }}>多专家协作</div>
              {curExpertTraces.map((t) => (
                <div key={t.stepId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', color: '#666' }}>
                  <span style={{ width: 16, textAlign: 'center', color: t.status === 'completed' ? '#52c41a' : t.status === 'failed' ? '#ff4d4f' : '#1677ff' }}>
                    {t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : '…'}
                  </span>
                  <span style={{ color: '#5b3b8e', fontWeight: 500 }}>{t.expertName}</span>
                  <span style={{ flex: 1, overflowWrap: 'break-word', wordBreak: 'break-word' }}>{t.title}</span>
                  {t.status === 'failed' && t.error && <span style={{ color: '#ff4d4f' }}>{t.error}</span>}
                </div>
              ))}
            </div>
          )}
          {/* 自修改（K5）动态扩展区：browser 半通过 slots.register 注册的组件渲染在这里（UI 热更新落点） */}
          {(clientComponents['dynamic-extension'] ?? []).map((reg) => (
            <div key={reg.id} style={{ marginBottom: 8, width: '100%' }}>
              <reg.Component />
            </div>
          ))}
        </div>

        {/* 审批弹窗（输入框上方浮动，会话级隔离：只显示当前会话的待审批请求） */}
        {curApproval && (
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
            <div style={{ color: '#555', marginBottom: 4 }}>工具：{curApproval.toolName}（风险 {curApproval.riskLevel}）</div>
            <div style={{ color: '#555', marginBottom: 10, fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
              {formatArgs(curApproval.args)}
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

        {/* 自修改（K5）：browser 半投递审批弹窗（agent 想往界面挂 UI 时需用户确认） */}
        {curClientRunRequest && (
          <div
            style={{
              position: 'absolute',
              bottom: 158,
              left: 16,
              right: 16,
              padding: 14,
              borderRadius: 12,
              border: '1px solid #1677ff',
              background: '#f0f7ff',
              fontSize: 13,
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6, color: '#333' }}>
              <IconCode />
              确认投递界面组件
            </div>
            <div style={{ color: '#555', marginBottom: 4 }}>
              动态包：<b>{curClientRunRequest.name}</b>（{curClientRunRequest.pkgId}）
            </div>
            <div style={{ color: '#555', marginBottom: 10, fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
              用途：{curClientRunRequest.purpose}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void respondClientRun(true)} style={btn('#1677ff', '#fff')}>
                投递到界面
              </button>
              <button onClick={() => void respondClientRun(false)} style={btn('#fff', '#333', '1px solid #ddd')}>
                拒绝
              </button>
            </div>
          </div>
        )}

        {/* 输入区（单卡片：textarea + 底部功能行 + 发送按钮）；空状态垂直居中，非空固定在底部 */}
        <div style={isEmpty ? { padding: '8px 16px 28px', flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } : { padding: '12px 16px 16px', borderTop: '1px solid #eee', background: '#fff' }}>
          <div style={{ border: '1px solid #d9d9d9', borderRadius: 16, padding: '10px 12px 8px 16px', background: '#fff', width: '100%', maxWidth: isEmpty ? 760 : 'none' }}>
            {attachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {attachments.map((a, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    {a.type === 'image' ? (
                      <img
                        src={a.dataUrl}
                        alt={a.name}
                        onClick={() => setPreviewImage(a.dataUrl)}
                        style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid #eee', display: 'block', cursor: 'zoom-in' }}
                      />
                    ) : (
                      <div style={{ width: 56, height: 56, borderRadius: 8, border: '1px solid #eee', background: '#f7f7f8', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#888', gap: 2, padding: '0 4px', boxSizing: 'border-box' }}>
                        {a.type === 'file' ? <IconFile /> : a.type === 'audio' ? <IconMic /> : <IconMonitor />}
                        {a.type === 'file' && (
                          <div style={{ fontSize: 8, lineHeight: 1.1, color: '#999', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {a.name.length > 8 ? `${a.name.slice(0, 8)}…` : a.name}
                          </div>
                        )}
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
            <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => void handleFileSelect(e)} />
            {queueCount > 0 && (
              <div style={{ marginBottom: 6, fontSize: 12, color: '#fa8c16', display: 'flex', alignItems: 'center', gap: 4 }}>
                <IconClock />
                排队中 {queueCount} 条消息，将在当前任务完成后自动执行
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onCompositionStart={() => { isComposingRef.current = true }}
              onCompositionEnd={() => { isComposingRef.current = false }}
              onKeyDown={(e) => {
                const composing = isComposingRef.current || e.nativeEvent.isComposing
                if (e.key === 'Enter' && !e.shiftKey && !composing) {
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 8 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0 }}>
                <button title="附件" onClick={() => fileRef.current?.click()} style={iconBtn}><IconPaperclip /></button>
                <div ref={modelMenuRef} style={{ position: 'relative' }}>
                  <button
                    onClick={() => setModelMenuOpen((v) => !v)}
                    style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 12, color: '#555', background: '#fff', outline: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 180, minWidth: 0 }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                      {models.find((m) => m.id === selectedModel)?.name ?? (loggedIn ? '选择模型' : '未登录')}
                    </span>
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
                </button>
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
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
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
        <TokenStatusBar stats={tokenStatsBySession[currentSessionId] ?? null} />
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

      {/* 执行轨迹面板：当前会话请求大模型的消息痕迹 + 工具调用痕迹（含角色与元数据） */}
      {tracePanelOpen && <TracePanel sessionId={currentSessionId} busy={cur.busy} streamingReasoning={cur.streamingReasoning} streaming={cur.streaming} onClose={() => setTracePanelOpen(false)} />}

      <style>{`* { box-sizing: border-box; } html, body, #root { margin: 0; height: 100%; overflow: hidden; } @keyframes blink { 50% { opacity: 0 } } @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } } @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.35 } 40% { transform: translateY(-3px); opacity: 1 } } @keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* 图片预览遮罩层：点击输入框/聊天历史里的图片放大查看，点击背景或 Esc 关闭 */}
      {previewImage && <ImagePreview src={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  )
}

/** 图片预览遮罩层：全屏半透明背景 + 居中大图，点击背景或 Esc 关闭 */
function ImagePreview({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        cursor: 'zoom-out',
      }}
    >
      <img
        src={src}
        alt="预览"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '92%', maxHeight: '92%', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}
      />
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
      out.push({ kind: 'assistant', content: h.content ?? '', reasoningContent: h.reasoningContent })
    } else if (h.trace) {
      const trace = h.trace
      if (trace.kind === 'tool-result') {
        // 合并到同 callId 的 tool-call 条目（否则同一工具调用会显示「执行中」+「已完成」两条）
        const idx = [...out].reverse().findIndex((it) => it.kind === 'tool' && it.trace.kind === 'tool-call' && it.trace.callId === trace.callId)
        if (idx >= 0) {
          const realIdx = out.length - 1 - idx
          const base = (out[realIdx] as Extract<ChatItem, { kind: 'tool' }>).trace
          out[realIdx] = { kind: 'tool', trace: { ...base, kind: 'tool-result', result: trace.result, error: trace.error } }
          continue
        }
      }
      out.push({ kind: 'tool', trace })
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

/** 空状态欢迎页：产品名 + 欢迎语 + 能力点 + 快捷提问（点击填入输入框） */
function WelcomeHero({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  const suggestions = [
    '帮我写一段 Python 脚本',
    '解释一下当前项目结构',
    '用一句话介绍你自己',
    '帮我分析一个文件',
  ]
  return (
    <div style={{ textAlign: 'center', maxWidth: 640, width: '100%', paddingBottom: 8 }}>
      <div style={{ fontSize: 44, fontWeight: 700, color: '#1677ff', letterSpacing: 2, marginBottom: 10 }}>山海</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: '#333', marginBottom: 8 }}>欢迎使用山海 AI 助手</div>
      <div style={{ fontSize: 13, color: '#888', lineHeight: 1.7, marginBottom: 22 }}>
        一个可自我升级的桌面智能体：多专家编排、真实工具执行、会话级隔离。
        <br />
        登录后解锁全部模型，也支持接入你自己的模型服务商。
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onSuggestion(s)}
            style={{ padding: '8px 14px', borderRadius: 18, border: '1px solid #e5e5e5', background: '#fff', color: '#555', fontSize: 13, cursor: 'pointer', transition: 'border-color 0.2s' }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#1677ff')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#e5e5e5')}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
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

function IconGlobe() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
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

function IconCode() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 4 }}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
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

/** 把字节数格式化成可读文本（B/KB/MB） */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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

function makeMarkdownComponents(onImageClick?: (url: string) => void) {
  return {
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
      return (
        <img
          src={props.src}
          alt={props.alt}
          onClick={() => props.src && onImageClick?.(props.src)}
          style={{ maxWidth: '100%', height: 'auto', borderRadius: 8, display: 'block', cursor: onImageClick ? 'zoom-in' : 'default' }}
        />
      )
    },
  }
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
      {props.busy && (
        <span
          title="任务执行中"
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '2px solid #d9e8ff',
            borderTopColor: '#1677ff',
            flexShrink: 0,
            animation: 'spin 0.8s linear infinite',
          }}
        />
      )}
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
  return (
    <div style={{ padding: '6px 16px', borderTop: '1px solid #eee', background: '#fff', fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontFamily: 'ui-monospace, monospace' }}>
      <span title="本次启动以来累计 token">
        累计 <b style={{ color: '#555' }}>{fmtTokens(stats.total)}</b>
        <span style={{ color: '#bbb' }}>（入 {fmtTokens(stats.totalPrompt)} / 出 {fmtTokens(stats.totalCompletion)}）</span>
      </span>
      <span title="本轮实时输入/输出 token（模型每次返回 usage 时更新）">
        本轮 <b style={{ color: '#1677ff' }}>入 {fmtTokens(stats.turnPrompt)} / 出 {fmtTokens(stats.turnCompletion)}</b>
      </span>
      <span title="本轮 prompt 缓存命中率（命中缓存 token / 本轮输入 token）">
        缓存命中 <b style={{ color: (stats.cacheHitRatio || 0) > 0 ? '#52c41a' : '#999' }}>{Math.round((stats.cacheHitRatio || 0) * 100)}%</b>
      </span>
      <span title="当前会话累计完成的任务循环轮次（一次完整的「用户消息 → 最终回复」算一轮）">
        轮次 <b style={{ color: '#1677ff' }}>{stats.turnCount}</b>
      </span>
      <span title="当前会话上下文窗口占用" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        上下文
        <ContextRing stats={stats} />
      </span>
    </div>
  )
}

/** 上下文窗口占用环形指示器：中间显示百分比，悬停弹出详情（最大窗口/当前占用/剩余可用/占比） */
function ContextRing({ stats }: { stats: TokenSnapshot }) {
  const [hover, setHover] = useState(false)
  const pct = Math.round((stats.contextUsageRatio || 0) * 100)
  const r = 9
  const c = 2 * Math.PI * r
  const color = pct > 80 ? '#ff4d4f' : pct > 60 ? '#faad14' : '#1677ff'
  const remaining = stats.contextLength > 0 ? Math.max(stats.contextLength - stats.lastPrompt, 0) : 0
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'help' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <svg width={22} height={22} viewBox="0 0 24 24">
        <circle cx={12} cy={12} r={r} fill="none" stroke="#f0f0f0" strokeWidth={3.5} />
        <circle
          cx={12}
          cy={12}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3.5}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(pct, 100) / 100)}
          strokeLinecap="round"
          transform="rotate(-90 12 12)"
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
        <text x={12} y={12.5} textAnchor="middle" dominantBaseline="central" fontSize={6.5} fill="#555" fontWeight={600}>
          {pct}%
        </text>
      </svg>
      {hover && (
        <div
          style={{
            position: 'absolute',
            bottom: '150%',
            right: 0,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            fontSize: 11,
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            zIndex: 100,
            lineHeight: 1.7,
          }}
        >
          <div>最大窗口：{stats.contextLength > 0 ? `${fmtTokens(stats.contextLength)} tokens` : '未知'}</div>
          <div>当前占用：{fmtTokens(stats.lastPrompt)} tokens</div>
          <div>剩余可用：{stats.contextLength > 0 ? `${fmtTokens(remaining)} tokens` : '未知'}</div>
          <div>上下文占比：{pct}%</div>
        </div>
      )}
    </span>
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

/** 把 AI 回复的气泡 DOM 节点原样截图成图片写入剪贴板（html-to-image 精确还原渲染效果，与界面显示一致，2x 高清） */
async function copyAssistantAsImage(node: HTMLElement | null): Promise<void> {
  if (!node) throw new Error('未找到要复制的消息节点')
  const dataUrl = await toPng(node, {
    pixelRatio: 2,
    backgroundColor: '#ffffff',
  })
  const blob = await (await fetch(dataUrl)).blob()
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
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
function UserMessage({ content, images, userIndex, busy, onResend, onEditResend, onPreviewImage }: {
  content: string
  images?: string[]
  userIndex: number
  busy: boolean
  onResend: (userIndex: number) => void
  onEditResend: (userIndex: number, newContent: string) => void
  onPreviewImage: (url: string) => void
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
        <img
          key={j}
          src={img}
          alt="附件"
          onClick={() => onPreviewImage(img)}
          style={{ maxWidth: 200, maxHeight: 200, borderRadius: 8, display: 'block', marginBottom: 4, objectFit: 'cover', cursor: 'zoom-in' }}
        />
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

/** 「思考过程」折叠区块（参考 DSH / DeepSeek：灰底、可折叠，与正式回答区分） */
function ReasoningBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(!!streaming)
  return (
    <div style={{ marginBottom: 8, maxWidth: '85%' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, border: '1px solid #eee', background: '#f7f7f8', color: '#888', fontSize: 12, cursor: 'pointer' }}
      >
        <span style={{ display: 'inline-flex', color: '#999', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}>
          <IconChevronDown />
        </span>
        {streaming ? '正在思考…' : '思考过程'}
      </button>
      {open && (
        <div style={{ marginTop: 4, padding: '8px 12px', borderRadius: 8, background: '#f7f7f8', color: '#888', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflowY: 'auto' }}>
          {content}
          {streaming && <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>}
        </div>
      )}
    </div>
  )
}

/** AI 助手消息卡片：左对齐，思考过程（可折叠）+ 正式回答，气泡下方固定显示「复制 / 复制为图片」操作 */
function AssistantMessage({ content, reasoningContent, onPreviewImage }: { content: string; reasoningContent?: string; onPreviewImage: (url: string) => void }) {
  const bubbleRef = useRef<HTMLDivElement>(null)
  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      {reasoningContent && <ReasoningBlock content={reasoningContent} />}
      <div ref={bubbleRef} style={{ maxWidth: '85%', padding: '10px 14px', borderRadius: 16, borderTopLeftRadius: 4, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.06)', fontSize: 14, lineHeight: 1.65, color: '#333', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(onPreviewImage)}>
          {content}
        </ReactMarkdown>
      </div>
      <MessageActions
        actions={[
          { key: 'copy', icon: <IconCopy />, label: '复制', run: () => copyText(content) },
          { key: 'copyImage', icon: <IconImage />, label: '复制为图片', run: () => copyAssistantAsImage(bubbleRef.current) },
        ]}
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

function IconActivity() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
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
  browser_create: { title: '创建浏览器窗口', icon: <IconGlobe /> },
  browser_list: { title: '列出浏览器窗口', icon: <IconGlobe /> },
  browser_navigate: { title: '打开网页', icon: <IconGlobe /> },
  browser_close: { title: '关闭浏览器窗口', icon: <IconGlobe /> },
  browser_screenshot: { title: '网页截图', icon: <IconGlobe /> },
  browser_get_info: { title: '读取页面信息', icon: <IconGlobe /> },
  browser_get_content: { title: '读取页面内容', icon: <IconGlobe /> },
  browser_evaluate: { title: '执行页面脚本', icon: <IconGlobe /> },
  browser_click: { title: '点击页面元素', icon: <IconGlobe /> },
  browser_type: { title: '页面输入', icon: <IconGlobe /> },
  browser_scroll: { title: '滚动页面', icon: <IconGlobe /> },
  browser_wait: { title: '等待元素', icon: <IconGlobe /> },
  browser_get_console_logs: { title: '查看控制台日志', icon: <IconGlobe /> },
  browser_get_network_requests: { title: '查看网络请求', icon: <IconGlobe /> },
  browser_get_cookies: { title: '读取 Cookie', icon: <IconGlobe /> },
  browser_set_cookie: { title: '设置 Cookie', icon: <IconGlobe /> },
  browser_clear_cookies: { title: '清除 Cookie', icon: <IconGlobe /> },
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
  if (name === 'browser_navigate') return String(a.url ?? '')
  if (name === 'browser_create') return a.url ? String(a.url) : a.appId ? String(a.appId) : ''
  if (name === 'browser_click') return String(a.selector ?? '')
  if (name === 'browser_type') return String(a.selector ?? '')
  if (name === 'browser_get_content') return a.selector ? String(a.selector) : ''
  if (name === 'browser_wait') return String(a.selector ?? '')
  if (name === 'browser_scroll') return String(a.direction ?? '')
  if (name === 'browser_close' || name === 'browser_list') return a.appId ? String(a.appId) : ''
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

/** 把工具结果转成可读字符串：字符串原样返回，对象/数组用 JSON 序列化（避免 [object Object]） */
function stringifyResult(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
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

// ===== 行级 diff（git diff 风格，用于 write_file 结果展示）=====

type DiffLineType = 'context' | 'add' | 'del' | 'fold'

interface DiffLine {
  type: DiffLineType
  text: string
  oldLine?: number
  newLine?: number
}

/** 用 LCS 计算两段文本的行级差异（经过公共前后缀裁剪后中间段通常较小，DP 可接受） */
function lcsDiff(a: string[], b: string[], oldStart: number, newStart: number): DiffLine[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i]!, oldLine: oldStart + i, newLine: newStart + j })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]!, oldLine: oldStart + i })
      i++
    } else {
      out.push({ type: 'add', text: b[j]!, newLine: newStart + j })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i]!, oldLine: oldStart + i })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j]!, newLine: newStart + j })
    j++
  }
  return out
}

/** 计算完整 diff，并折叠大段未变上下文（变更行前后保留 3 行，中间折叠标记） */
function computeDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  // 去掉公共前缀
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start++
  // 去掉公共后缀（不与前缀重叠）
  let endA = n
  let endB = m
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const lines: DiffLine[] = []
  for (let i = 0; i < start; i++) lines.push({ type: 'context', text: a[i]!, oldLine: i + 1, newLine: i + 1 })
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length > 4000 || midB.length > 4000) {
    // 中间段过大：退化为整段替换，避免 DP 内存爆炸
    for (const t of midA) lines.push({ type: 'del', text: t })
    for (const t of midB) lines.push({ type: 'add', text: t })
  } else {
    lines.push(...lcsDiff(midA, midB, start + 1, start + 1))
  }
  for (let i = 0; i < n - endA; i++) lines.push({ type: 'context', text: a[endA + i]!, oldLine: endA + i + 1, newLine: endB + i + 1 })

  // 折叠：变更行（add/del）前后各保留 ctx 行上下文，其余 context 折叠
  const ctx = 3
  const keep = new Set<number>()
  lines.forEach((l, i) => {
    if (l.type === 'add' || l.type === 'del') {
      for (let d = -ctx; d <= ctx; d++) {
        const j = i + d
        if (j >= 0 && j < lines.length) keep.add(j)
      }
    }
  })
  const out: DiffLine[] = []
  let lastKept = -1
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (lastKept >= 0 && i - lastKept > 1) {
        out.push({ type: 'fold', text: `⋯ ${i - lastKept - 1} 行未变` })
      }
      out.push(lines[i]!)
      lastKept = i
    }
  }
  return out
}

/** 文件变更卡片：git diff 风格（- 红 / + 绿 / 上下文灰），新建与修改文件都适用 */
function DiffBlock({ before, after, path, isNew }: { before: string; after: string; path?: string; isNew?: boolean }) {
  const treatAsNew = isNew || before === ''
  const diffLines: DiffLine[] = treatAsNew
    ? after.split('\n').map((t, i): DiffLine => ({ type: 'add', text: t, newLine: i + 1 }))
    : computeDiff(before, after)
  const addCount = diffLines.filter((l) => l.type === 'add').length
  const delCount = diffLines.filter((l) => l.type === 'del').length
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {path && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid #f0f0f0', color: '#999', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {path} · {treatAsNew ? `新建文件，+${addCount}` : `+${addCount} −${delCount}`}
        </div>
      )}
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {diffLines.map((l, i) => {
          if (l.type === 'fold') {
            return (
              <div key={i} style={{ padding: '3px 12px', color: '#999', fontSize: 11, background: '#fafafa', textAlign: 'center', userSelect: 'none' }}>
                {l.text}
              </div>
            )
          }
          const bg = l.type === 'add' ? '#e6ffec' : l.type === 'del' ? '#ffebe9' : 'transparent'
          const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '
          const signColor = l.type === 'add' ? '#1a7f37' : l.type === 'del' ? '#cf222e' : '#bbb'
          const textColor = l.type === 'del' ? '#82071e' : l.type === 'add' ? '#116329' : '#444'
          return (
            <div key={i} style={{ display: 'flex', background: bg, minHeight: 18 }}>
              <span style={{ width: 34, textAlign: 'right', paddingRight: 8, color: '#bbb', flexShrink: 0, userSelect: 'none', background: 'rgba(0,0,0,0.02)' }}>{l.oldLine ?? ''}</span>
              <span style={{ width: 34, textAlign: 'right', paddingRight: 8, color: '#bbb', flexShrink: 0, userSelect: 'none', background: 'rgba(0,0,0,0.02)' }}>{l.newLine ?? ''}</span>
              <span style={{ width: 20, textAlign: 'center', color: signColor, flexShrink: 0, userSelect: 'none', fontWeight: 600 }}>{sign}</span>
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1, color: textColor }}>{l.text || ' '}</span>
            </div>
          )
        })}
      </div>
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
  if (name === 'browser_screenshot') {
    const r = result as { imageBase64?: string }
    const src = r.imageBase64 ? `data:image/png;base64,${r.imageBase64}` : ''
    return src ? <img src={src} alt="网页截图" style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : null
  }
  if (name === 'write_file') {
    const r = result as { ok?: boolean; path?: string; before?: string | null; after?: string; isNew?: boolean }
    if (typeof r.after === 'string') {
      return <DiffBlock before={r.before ?? ''} after={r.after} path={r.path} isNew={!!r.isNew} />
    }
    return <div style={{ padding: '10px 12px', color: '#389e0d', fontSize: 12 }}>✓ 已写入 {r.path ?? ''}</div>
  }
  return (
    <pre style={{ margin: 0, padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, color: '#444', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto' }}>
      {redactSecret(truncate(stringifyResult(result), 4000))}
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
        <div style={{ marginTop: 4, maxWidth: '85%', border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa', overflow: 'hidden' }}>
          {resultBody}
        </div>
      )}
    </div>
  )
}

// ===== 执行轨迹面板（DSH Tracing 风格：展示请求大模型的消息痕迹 + 工具调用痕迹，含角色与元数据）=====

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

function TracePanel({ sessionId, busy, streamingReasoning, streaming, onClose }: {
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

  // Esc 关闭轨迹面板（标准交互，也便于键盘操作）
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
          {/* 流式进行中的思考 / 回答实时追加到轨迹末尾（尚未落盘为 assistant/message） */}
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
