import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ApprovalRequest,
  AttachmentItem,
  ChatItem,
  ClientComponentReg,
  ClientRunRequest,
  ContentPart,
  ExpertTrace,
  GatewayModel,
  HistoryItem,
  SessionUIState,
  SpeechRecognitionLike,
  SpeechRecognitionResultListLike,
  TokenSnapshot,
  ToolTrace,
} from './types'
import { EMPTY_SESSION } from './types'
import {
  IconActivity,
  IconAvatar,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconClose,
  IconCode,
  IconFile,
  IconFolder,
  IconLogout,
  IconMic,
  IconMonitor,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconSend,
  IconShield,
  IconSidebar,
  IconStop,
  IconWarn,
} from './components/icons'
import { bubble, btn, formatArgs, formatBytes, iconBtn, readFileAsDataUrl, smallIconBtn, ThinkingDots } from './components/ui'
import { AssistantMessage } from './components/AssistantMessage'
import { CustomModelDrawer } from './components/CustomModelDrawer'
import { ImagePreview } from './components/ImagePreview'
import { LoginModal } from './components/LoginModal'
import { MemoryPanel } from './components/MemoryPanel'
import { ReasoningBlock } from './components/ReasoningBlock'
import { SessionRow } from './components/SessionRow'
import { TokenStatusBar } from './components/TokenStatusBar'
import { ToolStep } from './components/ToolStep'
import { TracePanel } from './components/TracePanel'
import { UserMessage } from './components/UserMessage'
import { WelcomeHero } from './components/WelcomeHero'

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
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const modelMenuRef = useRef<HTMLDivElement>(null)
  // token 用量按会话隔离：每个会话独立的累计/本轮/上下文/缓存命中统计
  const [tokenStatsBySession, setTokenStatsBySession] = useState<Record<string, TokenSnapshot>>({})
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
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
  const draftRef = useRef<Record<string, { input: string; attachments: AttachmentItem[] }>>({})
  const [input, setInput] = useState('')
  // 输入法组合中标记：中文等 IME 用回车选词时不应触发发送（keydown 时 isComposing 为 true）
  const isComposingRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  // 语音输入：录音中标记 + Web Speech 识别实例（renderer 端原生语音识别，无需后端）
  const [recording, setRecording] = useState(false)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
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

  /** 语音输入：点击开始识别，再次点击停止（renderer 端 Web Speech 原生识别，结果填入输入框） */
  async function toggleRecording(): Promise<void> {
    if (recording) {
      recognitionRef.current?.stop()
      return
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike
      webkitSpeechRecognition?: new () => SpeechRecognitionLike
    }
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!SR) {
      console.error('当前环境不支持语音识别（Web Speech API 不可用）')
      return
    }
    let finalText = ''
    const recognition = new SR()
    recognition.lang = 'zh-CN'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.onresult = (event: SpeechRecognitionResultListLike) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        if (r && r.isFinal) finalText += r[0]?.transcript ?? ''
        else if (r) interim += r[0]?.transcript ?? ''
      }
      void interim
    }
    recognition.onend = () => {
      setRecording(false)
      if (finalText.trim()) setInput((prev) => (prev ? `${prev}${finalText.trim()}` : finalText.trim()))
    }
    recognition.onerror = (event: unknown) => {
      console.error('语音识别错误:', event)
      setRecording(false)
    }
    recognition.start()
    recognitionRef.current = recognition
    setRecording(true)
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
            onClick={() => setMemoryPanelOpen(true)}
            title="查看长期记忆"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid #eee', background: '#fff', color: '#666', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
          >
            <IconClock />
            记忆
          </button>
          <button
            onClick={() => setTracePanelOpen(true)}
            title="查看执行轨迹"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid #eee', background: '#fff', color: '#666', fontSize: 12, cursor: 'pointer', ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) }}
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
                <button
                  title={recording ? '停止录音' : '语音输入（录音识别）'}
                  onClick={() => void toggleRecording()}
                  style={{ ...iconBtn, color: recording ? '#ff4d4f' : undefined, animation: recording ? 'blink 1s step-start infinite' : undefined }}
                >
                  <IconMic />
                </button>
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

      {/* 自定义模型管理：全屏弹窗（左侧列表 + 右侧编辑区） */}
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
      {/* 长期记忆面板：展示跨会话记忆（配置型 + 经验型），支持删除 */}
      {memoryPanelOpen && <MemoryPanel onClose={() => setMemoryPanelOpen(false)} />}

      <style>{`* { box-sizing: border-box; } html, body, #root { margin: 0; height: 100%; overflow: hidden; } @keyframes blink { 50% { opacity: 0 } } @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } } @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.35 } 40% { transform: translateY(-3px); opacity: 1 } } @keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* 图片预览遮罩层：点击输入框/聊天历史里的图片放大查看，点击背景或 Esc 关闭 */}
      {previewImage && <ImagePreview src={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  )
}

/** 后端历史 → 前端 ChatItem（合并 tool-call + tool-result 为一条，提取图片附件） */
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
