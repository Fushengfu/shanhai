import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ApprovalRequest,
  AskRequest,
  AttachmentItem,
  BrowserWindowItem,
  ChatItem,
  ClientRunRequest,
  ContentPart,
  GatewayModel,
  HistoryItem,
  RetryPrompt,
  SessionListItem,
  SessionUIState,
  TokenSnapshot,
  ToolTrace,
} from './types'
import { EMPTY_SESSION } from './types'
import { formatBytes } from './components/ui'
import { SlotView } from './slots'
import { UIContext, type UIContextValue } from './ui-context'
import { patchUiStore, useUiStoreSelector, getUiStoreSnapshot } from './store-client'
import { AiOrb } from './components/AiOrb'
import './plugins/WelcomePlugin'
import './plugins/StatusbarPlugin'
import './plugins/PanelsPlugin'
import './plugins/OverlaysPlugin'
import './plugins/SidebarPlugin'
import './plugins/HeaderPlugin'
import './plugins/ChatPlugin'
import './plugins/ComposerPlugin'
import './plugins/TerminalPlugin'

export function App() {
  const ui = useUiStoreSelector((s) => ({
    loggedIn: s.loggedIn,
    username: s.username,
    loginOpen: s.loginOpen,
    currentSessionId: s.currentSessionId,
    sessions: s.sessions,
    sessionMap: s.sessionMap,
    models: s.models,
    selectedModel: s.selectedModel,
    currentTokenStats: s.tokenStatsBySession[s.currentSessionId] ?? null,
    curApproval: (s.approvalQueues[s.currentSessionId] ?? [])[0] ?? null,
    curAsk: (s.askQueues[s.currentSessionId] ?? [])[0] ?? null,
    browserWindows: s.browserWindows,
    approvalPolicy: s.approvalPolicy,
    retryPrompt: s.retryPrompt,
  }))
  const loggedIn = ui.loggedIn
  const username = ui.username
  const sessions = ui.sessions
  const currentSessionId = ui.currentSessionId
  const sessionMap = ui.sessionMap
  const models = ui.models
  const selectedModel = ui.selectedModel
  const browserWindows = ui.browserWindows
  const approvalPolicy = ui.approvalPolicy
  const retryPrompt = ui.retryPrompt
  const loginOpen = ui.loginOpen

  // 共享状态 store setter（值更新，内部 patchUiStore 深合并 + 广播，跨窗口一致）
  const setLoggedIn = (v: boolean): void => patchUiStore({ loggedIn: v })
  const setUsername = (v: string | null): void => patchUiStore({ username: v })
  const setSessions = (list: SessionListItem[]): void => patchUiStore({ sessions: list })
  const setCurrentSessionId = (id: string): void => patchUiStore({ currentSessionId: id })
  const setModels = (list: GatewayModel[]): void => patchUiStore({ models: list })
  const setSelectedModel = useCallback((id: string): void => patchUiStore({ selectedModel: id }), [])
  const setTokenStatsBySession = (v: Record<string, TokenSnapshot>): void => patchUiStore({ tokenStatsBySession: v })
  const setApprovalQueues = (v: Record<string, ApprovalRequest[]>): void => patchUiStore({ approvalQueues: v })
  const setAskQueues = (v: Record<string, AskRequest[]>): void => patchUiStore({ askQueues: v })
  const setBrowserWindows = (v: BrowserWindowItem[]): void => patchUiStore({ browserWindows: v })
  const setApprovalPolicyState = useCallback((p: 'ask' | 'workdir' | 'never'): void => patchUiStore({ approvalPolicy: p }), [])
  const setRetryPrompt = (v: RetryPrompt | null): void => patchUiStore({ retryPrompt: v })

  // 登录弹窗开关已上移到共享 store（跨窗口：Dock 点击「登录」→ patchUiStore({loginOpen:true}) → 聊天窗口据此弹出）
  const setLoginOpen = (v: boolean): void => patchUiStore({ loginOpen: v })
  // 主题：亮/暗模式（localStorage 持久化，data-theme 驱动 CSS 变量）
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('shanhai-theme') === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('shanhai-theme', theme)
    } catch {
      /* localStorage 不可用时静默忽略 */
    }
    // 广播给其他独立窗口（会话管家 / Dock / 桌面壳 / 应用窗口），让它们实时跟随主题切换
    window.shanhai?.setTheme(theme)
  }, [theme])
  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), [])
  // 订阅其它窗口（如会话管家）发起的主题切换：聊天窗口本身是写者，但也要响应管家窗口的切换，
  // 实现双向同步。setTheme 对相同值会 bail out，不会与自身广播形成死循环。
  useEffect(() => {
    const off = window.shanhai?.onThemeChange((t) => setTheme(t))
    return off
  }, [])
  const loadedSessions = useRef<Set<string>>(new Set())
  // 会话列表排序：进行中置顶；其余按「最近活跃时间」倒序（发消息/执行任务即刷新 lastActiveAt，最新活跃排最顶）
  const sortedSessions = useMemo(() => {
    const busyOf = (s: SessionListItem): boolean => sessionMap[s.id]?.busy ?? s.busy ?? false
    return [...sessions].sort((a, b) => {
      const ab = busyOf(a)
      const bb = busyOf(b)
      if (ab !== bb) return ab ? -1 : 1
      return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
    })
  }, [sessions, sessionMap])

  const [customModelDrawerOpen, setCustomModelDrawerOpen] = useState(false)
  const [tracePanelOpen, setTracePanelOpen] = useState(false)
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false)
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  // 图片预览：点击输入框/聊天历史里的图片放大查看（遮罩层，点击或 Esc 关闭）
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  // 跟踪当前会话 id（供审批回调等闭包读取最新值，避免捕获旧 state）
  const currentSessionIdRef = useRef('')
  // 每个会话的输入框草稿（输入到一半切换会话，切回来草稿不丢）
  const draftRef = useRef<Record<string, { input: string; attachments: AttachmentItem[] }>>({})
  // —— 输入态下沉：input / attachments 等高频输入态已移入 ChatComposer 组件，这里只保留 ——
  // ① composerRef：当前输入的真值缓存（App 的 send 从中读取，ChatComposer 每次 render 同步）；
  // ② composerSeed：外部重置信号（草稿恢复 / 新建清空 / 发送清空），seq 递增触发 ChatComposer 重同步自身输入态。
  const composerRef = useRef<{ input: string; attachments: AttachmentItem[] }>({ input: '', attachments: [] })
  const [composerSeed, setComposerSeed] = useState({ seq: 0, input: '', attachments: [] as AttachmentItem[] })
  // 外部重置 Composer 输入态（草稿恢复 / 新建清空 / 发送清空）
  const resetComposer = useCallback((input: string, attachments: AttachmentItem[]) => {
    composerRef.current = { input, attachments }
    setComposerSeed((prev) => ({ seq: prev.seq + 1, input, attachments }))
  }, [])
  /** 欢迎页建议点击：把建议文本填入输入框（保留现有附件），触发 ChatComposer 重同步 */
  const setComposerInput = useCallback((text: string) => {
    resetComposer(text, composerRef.current.attachments)
  }, [resetComposer])
  // 消息队列：任务执行中提交的新消息进入队列，任务完成后自动执行（队列模式）；queueId 用于出队时定位消息流里的「排队中」气泡
  const pendingQueue = useRef<Record<string, Array<{ queueId: string; text: string; parts: ContentPart[]; images: string[] }>>>({})
  // 当前会话排队中的消息数（UI 提示「排队中 N 条」）
  const [queueCount, setQueueCount] = useState(0)
  // 语音播报中标记：true 时聊天窗口显示 3D AI 特效（声波波纹 + 加速呼吸），播报结束自动复位
  const [isSpeaking, setIsSpeaking] = useState(false)
  // 自修改（K5）：browser 半投递的 round-trip 审批请求队列（按会话隔离）
  const [clientRunRequests, setClientRunRequests] = useState<Record<string, ClientRunRequest[]>>({})

  // 顶部状态栏（header + 浏览器标签条）实际高度：侧滑面板顶部从它下方开始，避免覆盖状态栏区域
  const headerWrapRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(52)
  useEffect(() => {
    const el = headerWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight > 0) setHeaderHeight(el.offsetHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cur = sessionMap[currentSessionId] ?? EMPTY_SESSION
  // 「继续执行」入口状态：从当前会话读取（会话级隔离，避免多会话/后台任务下按钮串扰）
  const incompleteTurn = cur.incompleteTurn
  // 当前会话的待审批请求（会话级隔离：只显示当前会话队列的头一个，并行会话互不串扰）
  const curApproval = ui.curApproval
  // 当前会话的待回答提问（会话级隔离：只显示当前会话队列的头一个）
  const curAsk = ui.curAsk
  // 当前会话的 browser 半投递审批请求
  const curClientRunRequest = (clientRunRequests[currentSessionId] ?? [])[0] ?? null

  const systemModels = models.filter((m) => !m.custom)
  const customModels = models.filter((m) => m.custom)
  const workDir = sessions.find((s) => s.id === currentSessionId)?.workDir ?? ''
  const workDirName = workDir ? (workDir.split(/[\\/]/).filter(Boolean).pop() ?? '工作目录') : '选择目录'

  const patchSession = useCallback(
    (id: string, patch: Partial<SessionUIState> | ((s: SessionUIState) => Partial<SessionUIState>)) => {
      const snap = getUiStoreSnapshot()
      const existing = snap.sessionMap[id]
      const base = existing ?? EMPTY_SESSION
      // 字段级 patch：只发送 patch 显式指定的字段，不展开已有 base（否则会把本地旧的 items 整体覆盖到主进程，
      // 覆盖掉 onSessionActivity('end') 刚重建的含正文 items，导致「执行完正文消失、重启后才出现」的竞态）。
      const next = typeof patch === 'function' ? patch(base) : patch
      // 会话首次写入：若 store 中尚无该会话（如切会话先写 incompleteTurn、再异步拉历史），字段级 patch
      // 会被 deepMerge 直接把 sessionMap[id] 置为仅含 patch 字段的残缺对象（缺 items/streaming/busy），
      // 渲染时 cur.items.length 抛 undefined 导致白屏。故首次写入必须补全 EMPTY_SESSION 的完整字段。
      patchUiStore({ sessionMap: { [id]: existing ? next : { ...EMPTY_SESSION, ...next } } })
    },
    [],
  )

  /** 终端面板开关（会话级）：只改当前会话的 terminalPanelOpen，切会话时 cur 自动切换、互不影响 */
  const setTerminalPanelOpen = useCallback(
    (v: boolean) => {
      const sid = currentSessionIdRef.current
      if (!sid) return
      patchSession(sid, { terminalPanelOpen: v })
    },
    [patchSession],
  )

  /** 重取模型列表并同步下拉框（启动 / 刷新 / 模型列表变化时调用） */
  const refreshModelsList = useCallback(async () => {
    const api = window.shanhai
    if (!api) return
    const list = await api.listModels()
    setModels(list)
    const current = await api.getCurrentModelId()
    const prev = getUiStoreSnapshot().selectedModel
    setSelectedModel(current && list.some((m) => m.id === current) ? current : list.some((m) => m.id === prev) ? prev : (list[0]?.id ?? ''))
  }, [])

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
        // 重启恢复：激活「最顶第一个」会话（按最近活跃时间倒序），而非未排序的 list[0]（Map 插入顺序）
        const first = [...list].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
        if (first) {
          void switchToSession(first.id)
        }
      })
      .catch(() => undefined)
    void refreshModelsList()
    const offModelsChanged = api.onModelsChanged(() => {
      // 后端刷新完成（启动自动刷新 / 手动刷新）后重取下拉框
      void refreshModelsList()
    })
    // 流式增量 / 工具过程 / 审批请求 / 提问 / token 已上移主进程 ui-store 监听维护，
    // 渲染进程只订阅 store 快照（useUiStore），不再单独订阅这些 runtime 事件。
    // 自修改（K5）：browser 半投递审批 + 代码投递 + 卸载
    const offClientRun = api.onClientRunRequest((req) => {
      const sid = req.sessionId ?? currentSessionIdRef.current
      if (!sid) return
      setClientRunRequests((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), req] }))
    })
    // 投递确认被决策（用户手动点，或管家 resolve_client_run 代管）后，主进程广播 resolved 事件，据此移除对应弹窗。
    // requestId 无会话维度，遍历所有会话队列移除命中项（幂等：用户手动点已 slice 过则 no-op）。
    const offClientRunResolved = api.onClientRunResolved((requestId) => {
      setClientRunRequests((prev) => {
        let changed = false
        const next: Record<string, ClientRunRequest[]> = {}
        for (const [sid, q] of Object.entries(prev)) {
          const filtered = q.filter((r) => r.requestId !== requestId)
          if (filtered.length !== q.length) changed = true
          if (filtered.length > 0) next[sid] = filtered
        }
        return changed ? next : prev
      })
    })
    void api.getApprovalPolicy().then((p) => setApprovalPolicyState(p)).catch(() => undefined)
    return () => {
      offModelsChanged()
      offClientRun()
      offClientRunResolved()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchSession, refreshModelsList])

  async function refreshSessions(): Promise<void> {
    const list = (await window.shanhai?.listSessions()) ?? []
    setSessions(list)
  }

  async function renameSession(id: string, title: string): Promise<void> {
    await window.shanhai?.renameSession(id, title)
    setSessions(getUiStoreSnapshot().sessions.map((s) => (s.id === id ? { ...s, title } : s)))
  }

  async function deleteSession(id: string): Promise<void> {
    await window.shanhai?.deleteSession(id)
    const snap = getUiStoreSnapshot()
    const sessionMapNext = { ...snap.sessionMap }
    delete sessionMapNext[id]
    patchUiStore({ sessionMap: sessionMapNext })
    // 同步清掉该会话的待审批队列和输入框草稿（后端 deleteSession 也会拒绝其 pending 审批）
    const approvalNext = { ...snap.approvalQueues }
    delete approvalNext[id]
    patchUiStore({ approvalQueues: approvalNext })
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

  const pickWorkdir = useCallback(async (): Promise<void> => {
    const sid = currentSessionIdRef.current
    if (!sid) return
    const current = getUiStoreSnapshot().sessions.find((s) => s.id === sid)?.workDir ?? ''
    const picked = await window.shanhai?.selectDirectory(current)
    if (!picked) return
    await window.shanhai?.setSessionWorkdir(sid, picked)
    const list = getUiStoreSnapshot().sessions.map((s) => (s.id === sid ? { ...s, workDir: picked } : s))
    patchUiStore({ sessions: list })
  }, [])

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
    // 保存当前会话输入框草稿，切回来不丢（从 composerRef 读当前输入真值）
    if (currentSessionId) {
      draftRef.current[currentSessionId] = composerRef.current
    }
    setCurrentSessionId(id)
    currentSessionIdRef.current = id
    // 终端面板开关已会话级隔离（SessionUIState.terminalPanelOpen），切会话时 cur 自动切换，无需手动收起
    // 恢复目标会话草稿（若有），否则清空输入框（通过 resetComposer 触发 ChatComposer 重同步）
    const draft = draftRef.current[id]
    resetComposer(draft?.input ?? '', draft?.attachments ?? [])
    await window.shanhai?.switchSession(id)
    // 会话级审批策略：切到该会话时同步其安全模式到 UI
    void window.shanhai?.getApprovalPolicy().then((p) => setApprovalPolicyState(p)).catch(() => undefined)
    // 会话级模型：切会话后同步该会话的模型到下拉框选中态（后端 switchSession 已回放 model/select）
    void refreshModelsList()
    // 会话级 token 统计：切会话后拉取该会话的用量（底部状态栏隔离）
    void window.shanhai?.getTokenStats().then((s) => patchUiStore({ tokenStatsBySession: { [id]: s } })).catch(() => undefined)
    // 会话级浏览器窗口：切会话后同步该会话打开的浏览器窗口到标签区
    void refreshBrowserWindows(id)
    // 检查是否有未完成的消息（决定是否显示「继续执行」按钮），会话级写入，不污染其他会话
    const incomplete = (await window.shanhai?.hasIncompleteTurn(id)) ?? false
    patchSession(id, { incompleteTurn: incomplete })
    // 重启恢复：检测是否有失败重试挂起快照，有则恢复「重试/取消」弹窗（与进程内失败交互一致）
    const snap = (await window.shanhai?.hasRetrySnapshot(id)) ?? null
    if (snap) {
      setRetryPrompt({ sessionId: id, message: snap.reason ?? '任务上次因网络/服务异常中断，是否重试？' })
    }
    setQueueCount(pendingQueue.current[id]?.length ?? 0)
    if (loadedSessions.current.has(id)) return
    loadedSessions.current.add(id)
    const history = (await window.shanhai?.getSessionHistory(id)) ?? []
    const items = historyToItems(history)
    // 首次加载：busy 必须取后端权威运行态（listSessions 的 busy = runningLoops.has），不能写死 false——
    // 否则「手机端/管家下发任务、后台执行」时切到该会话会把 busy=true 错误清零，
    // 发送按钮/会话列表不再显示「执行中」，并因 incompleteTurn 误判而误显示「继续执行」。
    // 「未完成轮次（可继续执行）」由 incompleteTurn state 单独承载，与 busy 无关。
    const busy = (await window.shanhai?.listSessions().then((l) => l?.find((s) => s.id === id)?.busy ?? false)) ?? false
    patchSession(id, { items, streaming: '', streamingReasoning: '', busy })
  }

  async function createSession(): Promise<void> {
    const id = await window.shanhai?.createSession()
    if (!id) return
    loadedSessions.current.add(id)
    patchSession(id, { items: [], streaming: '', streamingReasoning: '', busy: false })
    // 保存当前会话草稿，新建会话输入框清空（从 composerRef 读数，resetComposer 触发 ChatComposer 清空）
    if (currentSessionId) {
      draftRef.current[currentSessionId] = composerRef.current
    }
    setCurrentSessionId(id)
    currentSessionIdRef.current = id
    resetComposer('', [])
    await refreshSessions()
  }

  async function applyLoginUi(username: string): Promise<void> {
    setLoggedIn(true)
    setUsername(username)
    setLoginOpen(false)
    // 登录成功后刷新模型列表（含 apiKey/baseUrl），切换到真实网关模型
    const list = await window.shanhai!.listModels()
    setModels(list)
    const current = await window.shanhai!.getCurrentModelId()
    setSelectedModel(current && list.some((m) => m.id === current) ? current : (list[0]?.id ?? ''))
  }

  async function handleLogin(u: string, p: string): Promise<void> {
    const r = await window.shanhai!.login(u, p)
    await applyLoginUi(r.username)
  }

  async function handleRegister(u: string, p: string, nickname?: string, phone?: string, email?: string): Promise<void> {
    const r = await window.shanhai!.register(u, p, nickname, phone, email)
    await applyLoginUi(r.username)
  }

  async function handleLogout(): Promise<void> {
    await window.shanhai?.logout()
    setLoggedIn(false)
    setUsername(null)
    setModels([])
    setSelectedModel('')
  }

  async function handleAddModel(input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }): Promise<void> {
    const m = await window.shanhai?.addCustomModel(input)
    if (m) {
      setModels([...getUiStoreSnapshot().models, m])
      setSelectedModel(m.id)
      await window.shanhai?.switchModel(m.id)
    }
  }

  async function handleUpdateModel(id: string, input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }): Promise<void> {
    const m = await window.shanhai?.updateCustomModel(id, input)
    if (m) {
      setModels(getUiStoreSnapshot().models.map((x) => (x.id === id ? m : x)))
    }
  }

  async function handleRemoveModel(id: string): Promise<void> {
    await window.shanhai?.removeCustomModel(id)
    setModels(getUiStoreSnapshot().models.filter((m) => m.id !== id))
    if (selectedModel === id) setSelectedModel('')
  }

  /** 切换当前模型（会话级），供模型下拉框与自定义模型面板共用 */
  const selectModel = useCallback((id: string): void => {
    setSelectedModel(id)
    void window.shanhai?.switchModel(id)
  }, [setSelectedModel])

  /** 切换安全模式（审批策略）并持久化 */
  const switchApprovalPolicy = useCallback((policy: 'ask' | 'workdir' | 'never'): void => {
    setApprovalPolicyState(policy)
    void window.shanhai?.setApprovalPolicy(policy)
  }, [setApprovalPolicyState])

  /** 任务完成自动语音播报：受「语音播报」开关控制，清洗 markdown 符号后截断播报，避免 TTS 读出 ``` 等符号；失败静默忽略。
   *  播报期间置 isSpeaking=true，聊天窗口显示 3D AI 特效；播完（无论成败）复位。 */
  async function speakResult(text: string): Promise<void> {
    try {
      const settings = await window.shanhai?.getSettings()
      if (!settings?.voice?.enabled) return
      const cleaned = text
        .replace(/```[\s\S]*?```/g, '（代码略）')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#>*_~|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!cleaned) return
      const MAX = 500
      const snippet = cleaned.length > MAX ? `${cleaned.slice(0, MAX)}，等` : cleaned
      setIsSpeaking(true)
      try {
        await window.shanhai?.speak(snippet)
      } finally {
        setIsSpeaking(false)
      }
    } catch {
      // 播报失败静默忽略，不影响主流程；确保特效复位
      setIsSpeaking(false)
    }
  }

  /** 队列模式：任务执行中提交的消息进入队列，任务完成后自动逐条执行（对齐 taco 的 addToQueue/injectQueuedMessage） */
  async function doRun(sid: string, text: string, parts: ContentPart[], images: string[], opts?: { queueId?: string }): Promise<void> {
    const startTs = Date.now()
    // 发消息即活跃：立即同步会话列表（活跃时间刷新 + 该会话置顶），否则侧边栏仍显示上次的历史活跃时间
    void refreshSessions()
    if (opts?.queueId) {
      // 出队执行：该消息已作为「排队中」气泡显示在消息流里，此处仅去掉排队标记（不重复追加用户气泡）
      patchSession(sid, (s) => ({
        items: s.items.map((it) => (it.kind === 'user' && it.queueId === opts.queueId ? { ...it, pending: false } : it)),
        streaming: '',
        streamingReasoning: '',
        busy: true,
        turnStartTs: startTs,
      }))
    } else {
      // 轮次序号 = 会话内 user 消息序号（从 1 开始）
      patchSession(sid, (s) => ({ items: [...s.items, { kind: 'user', content: text, images, turnSeq: s.items.filter((it) => it.kind === 'user').length + 1 }], streaming: '', streamingReasoning: '', busy: true, turnStartTs: startTs }))
    }
    let interrupted = false
    let retryExhausted = false
    try {
      const result = (await window.shanhai?.run(text, parts)) ?? ''
      // 中断返回：run() 返回「（已中断...）」，此时应保留「继续执行」入口（本轮 turn 未 end）
      interrupted = result.startsWith('（已中断')
      // 任务完成自动语音播报：仅正常完成（非中断）且正文非空时，超长截断后走 TTS（受「语音播报」开关控制）
      if (!interrupted && result.trim()) void speakResult(result)
      // 正常完成：assistant 正文气泡由主进程 ui-store 的 onSessionActivity('end') 用 getSessionHistory 重建
      // （assistant/message 连同思考、耗时已落盘到 session），这里不再重复 push——
      // 否则会出现「带工具调用」+「纯正文」两个重复的 assistant 气泡。
      // 仅中断时（loop 未落盘 assistant/message）补一个「已中断」提示气泡。
      if (interrupted) {
        patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: result, turnSeq: s.items.filter((it) => it.kind === 'user').length, turnDuration: Date.now() - startTs }] }))
      }
    } catch (err) {
      // 可重试错误（网络/余额不足等）已自动重试耗尽：弹窗让用户选「重试（重新发网络请求，body 与失败一致）/取消（放弃）」。
      // 不显示「错误：」气泡——尚未产出正文，由弹窗承载失败信息；失败态不显示「继续执行」，用弹窗作为唯一入口。
      if (isRetryExhausted(err)) {
        setRetryPrompt({ sessionId: sid, message: retryExhaustedMessage(err) })
        retryExhausted = true
      } else {
        patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}`, turnSeq: s.items.filter((it) => it.kind === 'user').length, turnDuration: Date.now() - startTs }] }))
      }
    } finally {
      // 闪屏修复：正常完成/中断/普通错误时，主进程 onSessionActivity('end') 会同步重建 items + 置 busy=false
      // 并广播 ui:state；渲染进程不再本地抢跑置 busy（否则会与主进程广播形成「先清流式、后重建 items」的竞态闪屏）。
      // 仅 retryExhausted（主进程 suspended=true、不广播 ui:state）时本地兜底置 busy=false。
      if (retryExhausted) {
        patchSession(sid, { streaming: '', streamingReasoning: '', busy: false })
      }
      // 中断时保留「继续执行」入口；正常完成 / 报错才清除（失败重试耗尽时不显示「继续执行」，由弹窗承载）
      patchSession(sid, { incompleteTurn: interrupted })
      // 任务结束（成功/失败/中断/重试耗尽）同步会话列表：后端已把活跃时间更新为结束时间，这里重新拉取让侧边栏实时刷新
      void refreshSessions()
      // 出队：执行队列中下一条消息（失败弹窗期间暂停出队，等用户决定重试/取消后再继续）
      if (!retryExhausted) drainQueue(sid)
    }
  }

  /** 出队执行当前会话队列中的下一条消息（重试/取消完成后也要继续队列） */
  function drainQueue(sid: string): void {
    const q = pendingQueue.current[sid]
    if (q && q.length > 0) {
      const next = q.shift()!
      if (sid === currentSessionId) setQueueCount(q.length)
      void doRun(sid, next.text, next.parts, next.images, { queueId: next.queueId })
    }
  }

  /** doRun 的最新引用（供 useCallback 化的 send 调用，避免闭包捕获旧 doRun） */
  const doRunRef = useRef<(sid: string, text: string, parts: ContentPart[], images: string[], opts?: { queueId?: string }) => Promise<void>>(doRun)
  doRunRef.current = doRun

  const send = useCallback(async (): Promise<void> => {
    const sid = currentSessionIdRef.current
    if (!sid) return
    const { input: inputText, attachments } = composerRef.current
    const text = inputText.trim()
    if (!text && attachments.length === 0) return
    // 图片必须已上传（拿到 https 链接）才能发送：上传中/上传失败都阻止，绝不用 base64 data URL（会撑爆上下文）
    if (attachments.some((a) => a.type === 'image' && a.uploadStatus !== 'done')) return
    const images = attachments.filter((a) => a.type === 'image').map((a) => a.dataUrl)
    const parts: ContentPart[] = []
    const fileNotes: string[] = []
    for (const a of attachments) {
      if (a.type === 'image') {
        // 图片只用云存储 https 链接，绝不带 base64 data URL（避免撑爆上下文 / 非视觉模型 400）
        const url = a.url
        if (!url) continue
        parts.push({ type: 'image_url', image_url: { url } })
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
    resetComposer('', [])
    delete draftRef.current[sid]
    if (getUiStoreSnapshot().sessionMap[sid]?.busy ?? false) {
      const q = pendingQueue.current[sid] ?? []
      let mode: 'queue' | 'insert' = 'queue'
      try {
        mode = (await window.shanhai?.getSettings())?.messageSubmit?.mode ?? 'queue'
      } catch {
        // 读取配置失败用默认队列模式
      }
      if (mode === 'insert') {
        // 插入模式：向正在执行的任务注入消息（不中断当前任务），不显示为独立用户气泡——
        // 追加的需求/问题在任务完成的最终回答正文里，由模型用「追加需求回应」小节显式体现。
        const injected = (await window.shanhai?.injectMessage(sid, finalText)) ?? false
        if (!injected) {
          // 没有运行中的任务（可能刚好结束）：回退队列，显示「排队中」气泡
          const queueId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          patchSession(sid, (s) => ({ items: [...s.items, { kind: 'user', content: finalText, images, pending: true, queueId, turnSeq: s.items.filter((it) => it.kind === 'user').length + 1 }] }))
          pendingQueue.current[sid] = [...q, { queueId, text: finalText, parts, images }]
        }
      } else {
        // 队列模式：新消息立即显示为「排队中」气泡（可见实际内容），任务完成后自动逐条执行
        const queueId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        patchSession(sid, (s) => ({ items: [...s.items, { kind: 'user', content: finalText, images, pending: true, queueId, turnSeq: s.items.filter((it) => it.kind === 'user').length + 1 }] }))
        pendingQueue.current[sid] = [...q, { queueId, text: finalText, parts, images }]
      }
      setQueueCount((pendingQueue.current[sid] ?? []).length)
      return
    }
    void doRunRef.current(sid, finalText, parts, images)
  }, [patchSession, resetComposer, setQueueCount])

  async function respondApproval(outcome: 'allowed-once' | 'rejected'): Promise<void> {
    // 只响应当前会话队列的头一个待审批请求（会话级隔离）
    const req = curApproval
    if (!req) return
    await window.shanhai?.respondApproval(outcome, req.id)
    // 弹窗关闭由 runtime 的 onApprovalResolved 事件统一驱动（ui-store removeApprovalRequest），
    // 此处不再手动 patchUiStore 移除，避免与 resolved 事件双重移除。
  }

  /** 回答 AI 的提问（只响应当前会话队列的头一个，会话级隔离） */
  async function respondAsk(answer: string): Promise<void> {
    const req = curAsk
    if (!req) return
    await window.shanhai?.respondAsk(req.id, answer)
    // 弹窗关闭由 runtime 的 onAskResolved 事件统一驱动（ui-store removeAskRequest），
    // 此处不再手动 patchUiStore 移除，避免与 resolved 事件双重移除。
  }

  /** 取消 AI 的提问/选择（只取消当前会话队列的头一个，会话级隔离；resolve 为取消标记而非把取消当答案） */
  async function cancelAsk(): Promise<void> {
    const req = curAsk
    if (!req) return
    await window.shanhai?.cancelAsk(req.id)
    // 弹窗关闭由 runtime 的 onAskResolved 事件统一驱动（ui-store removeAskRequest），
    // 此处不再手动 patchUiStore 移除，避免与 resolved 事件双重移除。
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

  /** 应答失败重试弹窗：retry = 重新发网络请求（body 与失败一致）；cancel = 关闭弹窗，保留「继续执行」入口 */
  function respondRetry(action: 'retry' | 'cancel'): void {
    setRetryPrompt(null)
    if (action === 'retry') {
      // 重试 = 重新提交失败节点那一次请求（上下文 body 与上次一致），而非重新开始、非重新回放历史
      retrySession()
    } else {
      // 取消 = 关闭弹窗，保留「继续执行」入口（任务挂起，可稍后手动续跑）
      abandonSession()
    }
  }

  /** 重新发送：截断到该用户消息重新生成（对齐 taco 的 resendFromExisting，直接重发，不填回输入框） */
  function resendMessage(userIndex: number): void {
    const sid = currentSessionId
    if (!sid) return
    // 立即从该节点截断视图：保留该用户消息（含），移除其后的所有回复/工具步骤，再走后端截断 + 重跑。
    // 对齐 taco：重发 = 从该节点截断重新生成，而非等整个重发完成才一次性刷新（否则旧回复会一直残留显示）。
    patchSession(sid, (s) => {
      const cutAt = userItemIndex(s.items, userIndex)
      const items = cutAt >= 0 ? s.items.slice(0, cutAt + 1) : s.items
      return { items, busy: true, streaming: '', streamingReasoning: '', turnStartTs: Date.now() }
    })
    void window.shanhai?.resend(sid, userIndex).then((result) => {
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      if (isRetryExhausted(err)) {
        setRetryPrompt({ sessionId: sid, message: retryExhaustedMessage(err) })
        patchSession(sid, { streaming: '', streamingReasoning: '', busy: false })
      } else {
        patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }], streaming: '', streamingReasoning: '', busy: false }))
      }
    })
  }

  /** 编辑后重发：截断到该消息，用新内容重新生成 */
  function editResend(userIndex: number, newContent: string): void {
    const sid = currentSessionId
    if (!sid) return
    // 立即截断：保留该用户消息之前的内容，该用户消息替换为新内容，移除其后所有回复
    patchSession(sid, (s) => {
      const cutAt = userItemIndex(s.items, userIndex)
      const target = cutAt >= 0 ? s.items[cutAt] : undefined
      if (!target || target.kind !== 'user') return { busy: true, streaming: '', streamingReasoning: '', turnStartTs: Date.now() }
      const items = [...s.items.slice(0, cutAt), { ...target, content: newContent }]
      return { items, busy: true, streaming: '', streamingReasoning: '', turnStartTs: Date.now() }
    })
    void window.shanhai?.resend(sid, userIndex, newContent).then((result) => {
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      if (isRetryExhausted(err)) {
        setRetryPrompt({ sessionId: sid, message: retryExhaustedMessage(err) })
        patchSession(sid, { streaming: '', streamingReasoning: '', busy: false })
      } else {
        patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }], streaming: '', streamingReasoning: '', busy: false }))
      }
    })
  }

  /** 继续执行：断点续跑——保留已执行步骤，从断点继续（后端从会话日志回放恢复，不清空历史） */
  function resumeMessage(): void {
    const sid = currentSessionId
    if (!sid) return
    // 不截断 items：已执行的工具步骤/回复保持不变，仅置 busy 等待断点续跑
    patchSession(sid, (s) => ({ busy: true, streaming: '', streamingReasoning: '', turnStartTs: Date.now() }))
    void window.shanhai?.resume(sid).then((result) => {
      void reloadSessionItems(sid, result)
    }).catch((err) => {
      // 续跑再次失败：若仍是可重试错误（网络/余额不足等），重新弹窗让用户再选；否则显示错误气泡
      if (isRetryExhausted(err)) {
        setRetryPrompt({ sessionId: sid, message: retryExhaustedMessage(err) })
        patchSession(sid, { streaming: '', streamingReasoning: '', busy: false })
      } else {
        patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }], streaming: '', streamingReasoning: '', busy: false }))
      }
    })
  }

  /** 失败重试：用失败节点相同的 messages 快照重新提交请求（不截断视图、不重新开始、不重新回放历史） */
  function retrySession(): void {
    const sid = currentSessionId
    if (!sid) return
    // 不截断 items：重试是在失败节点继续，已有消息/工具步骤保持不变，仅置 busy 等待重新生成
    patchSession(sid, (s) => ({ busy: true, streaming: '', streamingReasoning: '', turnStartTs: Date.now() }))
    void window.shanhai?.retry(sid).then((result) => {
      void reloadSessionItems(sid, result)
      drainQueue(sid)
    }).catch((err) => {
      // 重试又失败：仍可重试则再次弹窗，否则显示错误气泡
      if (isRetryExhausted(err)) {
        setRetryPrompt({ sessionId: sid, message: retryExhaustedMessage(err) })
        patchSession(sid, { streaming: '', streamingReasoning: '', busy: false })
      } else {
        patchSession(sid, (s) => ({ items: [...s.items, { kind: 'assistant', content: `错误：${String(err)}` }], streaming: '', streamingReasoning: '', busy: false }))
      }
    })
  }

  /** 取消重试：清理挂起 loop，保留「继续执行」入口（任务挂起，可稍后手动续跑） */
  function abandonSession(): void {
    const sid = currentSessionId
    if (!sid) return
    // 关闭弹窗后保留「继续执行」入口（任务挂起，未完成轮次仍可续跑），会话级写入
    patchSession(sid, { incompleteTurn: true, busy: false, streaming: '', streamingReasoning: '' })
    void window.shanhai?.abandon(sid).then(() => {
      drainQueue(sid)
    }).catch(() => {
      // 取消清理失败静默（本地状态已处理，不影响用户继续使用）
    })
  }

  /** 从后端重新拉取会话历史，刷新前端视图（重发/编辑/续跑后截断状态与后端对齐） */
  async function reloadSessionItems(sid: string, _result: string): Promise<void> {
    const history = (await window.shanhai?.getSessionHistory(sid)) ?? []
    patchSession(sid, { items: historyToItems(history), streaming: '', streamingReasoning: '', busy: false })
    // 重发/编辑/续跑/重试完成后同步会话列表：活跃时间已更新为结束时间，重新拉取让侧边栏实时刷新
    void refreshSessions()
    // 续跑/重发完成后刷新「未完成轮次」状态：后端事件日志已补全 assistant/message + turn/end，
    // 必须重新查询 hasIncompleteTurn 才能让「继续执行」按钮正确消失（此前只刷 items 不刷该 state）。
    const incomplete = (await window.shanhai?.hasIncompleteTurn(sid)) ?? false
    patchSession(sid, { incompleteTurn: incomplete })
  }

  const stopSend = useCallback((): void => {
    const sid = currentSessionIdRef.current
    // 立即给用户反馈：停止三点动画/流式渲染，busy 置 false（对齐 taco：点停止即停，不再等后端慢慢返回才刷新）。
    // 后端 stop() 会中止运行中的 loop，run() 返回后 doRun 的 finally 兜底再次置 false（幂等）。
    if (sid) {
      patchSession(sid, { busy: false, streaming: '', streamingReasoning: '' })
    }
    void window.shanhai?.stop()
  }, [patchSession])

  // 空状态：当前会话还没有任何消息（新建会话 / 首次使用默认会话）
  const isEmpty = cur.items.length === 0

  // UI 插件上下文：把 shell 的应用状态派生给各 slot 插件组件（对齐 K3「组件 props 由框架派生」）
  const uiContextValue: UIContextValue = {
    // 通用
    loggedIn,
    username,
    currentSessionId,
    cur,
    isEmpty,
    sidebarCollapsed,
    setSidebarCollapsed,
    headerHeight,
    theme,
    toggleTheme,
    // sidebar
    sortedSessions,
    sessionBusy: (id) => sessionMap[id]?.busy ?? (sessions.find((s) => s.id === id)?.busy ?? false),
    editingSessionId,
    editingTitle,
    setEditingTitle,
    createSession,
    renameSession,
    deleteSession,
    switchToSession,
    setEditingSessionId,
    handleLogout,
    setLoginOpen,
    // header
    setMemoryPanelOpen,
    setTracePanelOpen,
    setSettingsPanelOpen,
    browserWindows,
    showBrowserWindow,
    closeBrowserWindow,
    // chat
    incompleteTurn,
    curApproval,
    curAsk,
    curClientRunRequest,
    retryPrompt,
    resendMessage,
    editResend,
    resumeMessage,
    setPreviewImage,
    respondApproval,
    respondAsk,
    cancelAsk,
    respondClientRun,
    respondRetry,
    // composer
    composerRef,
    composerSeed,
    setComposerInput,
    queueCount,
    models,
    selectedModel,
    setSelectedModel,
    systemModels,
    customModels,
    approvalPolicy,
    workDir,
    workDirName,
    send,
    stopSend,
    pickWorkdir,
    switchApprovalPolicy,
    selectModel,
    handleRemoveModel,
    setCustomModelDrawerOpen,
    // statusbar
    currentTokenStats: ui.currentTokenStats,
    // panels
    customModelDrawerOpen,
    addCustomModel: handleAddModel,
    updateCustomModel: handleUpdateModel,
    removeCustomModel: handleRemoveModel,
    tracePanelOpen,
    memoryPanelOpen,
    settingsPanelOpen,
    // terminal（会话级：cur.terminalPanelOpen 派生，切会话自动隔离）
    terminalPanelOpen: cur.terminalPanelOpen,
    setTerminalPanelOpen,
    // overlays
    loginOpen,
    handleLogin,
    handleRegister,
    previewImage,
  }

  return (
    <UIContext.Provider value={uiContextValue}>
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', background: 'var(--bg-app)' }}>
      {/* 侧边栏：会话列表（可折叠） */}
      <aside
        style={
          {
            width: sidebarCollapsed ? 0 : 200,
            borderRight: sidebarCollapsed ? 'none' : '1px solid var(--border)',
            background: 'var(--bg-app)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            transition: 'width 0.2s ease',
            WebkitAppRegion: 'drag',
          } as React.CSSProperties
        }
      >
        <SlotView slot="shell.sidebar" />
      </aside>

      {/* 主区 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <div ref={headerWrapRef} style={{ flexShrink: 0 }}>
          <SlotView slot="shell.header" />
        </div>
        <SlotView slot="shell.chat" />
        <SlotView slot="shell.composer" />
        <SlotView slot="shell.statusbar" />
        <SlotView slot="shell.terminal" />
      </div>

      {/* 侧滑面板层（自定义模型 / 执行轨迹 / 长期记忆 / 设置）：通过 slot 插件渲染，可被 selfmod 替换 */}
      <SlotView slot="shell.panels" />

      <style>{`* { box-sizing: border-box; } html, body, #root { margin: 0; height: 100%; overflow: hidden; } * { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.22) transparent; } *::-webkit-scrollbar { width: 6px; height: 6px; } *::-webkit-scrollbar-track { background: transparent; } *::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.22); border-radius: 3px; } *::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.38); }`}</style>

      {/* 遮罩层（登录弹窗 / 图片预览）：通过 slot 插件渲染，可被 selfmod 替换 */}
      <SlotView slot="shell.overlays" />

      {/* 语音播报量子粒子特效浮层：用 portal 挂到 body，绝对置顶居中、点击穿透；播报结束 isSpeaking=false 自动卸载 */}
      {isSpeaking &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 2147483647,
              background: 'rgba(0,0,0,0.10)',
            }}
          >
            <AiOrb speaking />
            <div
              style={{
                marginTop: 24,
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: 0.5,
                color: 'var(--text-secondary)',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-soft)',
                borderRadius: 999,
                padding: '6px 16px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
              }}
            >
              AI 正在播报…
            </div>
          </div>,
          document.body,
        )}
    </div>
    </UIContext.Provider>
  )
}

/** 后端历史 → 前端 ChatItem（合并 tool-call + tool-result 为一条，提取图片附件） */
/** 判断错误是否为「可重试错误已耗尽」（agent 自动重试 5 次全失败后抛出的 __retry_exhausted__::<原因>）。
 * 用 String(err) 判断而非 err.message：Electron IPC invoke 会加 "Error invoking remote method" 前缀，message 精确匹配会失效。 */
function isRetryExhausted(err: unknown): boolean {
  return String(err).includes('__retry_exhausted__')
}

/** 从 __retry_exhausted__::<原因> 错误中提取失败原因（展示给用户） */
function retryExhaustedMessage(err: unknown): string {
  const m = /__retry_exhausted__::(.+)$/.exec(String(err))
  return m?.[1]?.trim() || String(err)
}

/** 找到第 userIndex 条 user 消息在 items 中的索引（-1 表示不存在）。items 已由 historyToItems 过滤掉 injected 消息。 */
function userItemIndex(items: ChatItem[], userIndex: number): number {
  let count = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it?.kind === 'user') {
      if (count === userIndex) return i
      count++
    }
  }
  return -1
}

function historyToItems(history: HistoryItem[]): ChatItem[] {
  const out: ChatItem[] = []
  for (const h of history) {
    if (h.kind === 'user') {
      const images = (h.attachments ?? [])
        .map((a) => (a as ContentPart)?.image_url?.url)
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
      out.push({ kind: 'user', content: h.content ?? '', images, turnSeq: h.turnSeq })
    } else if (h.kind === 'assistant') {
      out.push({ kind: 'assistant', content: h.content ?? '', reasoningContent: h.reasoningContent, turnSeq: h.turnSeq, turnDuration: h.turnDuration })
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
