import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { getUiStoreSnapshot, patchUiStore, useUiStoreSelector, useStreaming } from '../store-client'
import { EMPTY_SESSION, type ChatItem, type ContentPart, type HistoryItem, type SessionListItem, type SessionUIState } from '../types'
import { WindowTitleBar } from '../components/WindowTitleBar'
import { AiOrb } from '../components/AiOrb'
import { AssistantMessage } from '../components/AssistantMessage'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { makeMarkdownComponents, normalizeTreeBlocks, stripWrappedRecordTag } from '../components/Markdown'
import { ImagePreview } from '../components/ImagePreview'
import { UserMessage } from '../components/UserMessage'
import { ToolStep, StepStats, toolDisplayName, riskLevelLabel } from '../components/ToolStep'
import { ReasoningBlock } from '../components/ReasoningBlock'
import { AskCard } from '../components/AskCard'
import { SessionPicker } from '../components/SessionPicker'
import { ModelPicker } from '../components/ModelPicker'
import { SupervisorComposer, type SupervisorComposerHandle } from './SupervisorComposer'
import { TokenStatusBar } from '../components/TokenStatusBar'
import { VirtualList } from '../components/VirtualList'
import { IconMonitor, IconWarn, IconMoon, IconSun } from '../components/icons'
import { btn, formatBytes, prettyValue, LiveDuration, ThinkingDots } from '../components/ui'
import { useThemeSync, readTheme, applyTheme, type ThemeMode } from '../theme'

/** 会话管家超级会话的固定 id（与 runtime 的 SUPERVISOR_ID 一致） */
const SUPERVISOR_SID = 'supervisor'

/** AI 回复气泡通用底样（与 ChatPlugin 保持一致） */
const AI_BUBBLE_STYLE: React.CSSProperties = {
  width: '85%',
  boxSizing: 'border-box',
  padding: '10px 14px',
  borderRadius: 16,
  borderTopLeftRadius: 4,
  background: 'var(--bg-panel)',
  boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
  fontSize: 14,
  lineHeight: 1.65,
  color: 'var(--text)',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  minWidth: 0,
  userSelect: 'text',
  WebkitUserSelect: 'text',
}

/**
 * 历史消息块容器。此前为 resize 减重用 content-visibility:auto 跳过视口外块绘制，
 * 但引入 VirtualList 真虚拟化后，content-visibility 与虚拟化的高度测量冲突：
 * 视口外块被 content-visibility 按 contain-intrinsic-size 占位（高度不稳定），导致 ResizeObserver
 * 实测高度在「占位/真实」间反复横跳，scrollHeight 抖动、滚动位置被浏览器 clamp 拽回底部。
 * 现与 ChatPlugin 对齐：块不再用 content-visibility（虚拟化已真正减 DOM，无需再跳过绘制），保留空占位容器。
 */
const HISTORY_BLOCK_STYLE: React.CSSProperties = {}

/** 把后端历史消息（HistoryItem[]）转换为消息流 items（ChatItem[]）：tool-result 合并到同 callId 的 tool-call */
function historyToItems(history: HistoryItem[]): ChatItem[] {
  const out: ChatItem[] = []
  // tool-call 的 callId → 在 out 中的下标：避免每条 tool-result 都 reverse+findIndex 的 O(n²)
  const toolCallIndex = new Map<string, number>()
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
        const realIdx = toolCallIndex.get(trace.callId)
        if (realIdx !== undefined) {
          const base = (out[realIdx] as Extract<ChatItem, { kind: 'tool' }>).trace
          out[realIdx] = { kind: 'tool', trace: { ...base, kind: 'tool-result', result: trace.result, error: trace.error } }
          continue
        }
      } else if (trace.kind === 'tool-call') {
        toolCallIndex.set(trace.callId, out.length)
      }
      out.push({ kind: 'tool', trace })
    }
  }
  return out
}

/** 定位第 userIndex 条用户消息在 items 数组中的下标（0 起），用于截断重发 */
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

/** 管家工具审批参数 key → 中文标签（未命中则显示原 key，兼容通用工具） */
const SUPERVISOR_ARG_LABELS: Record<string, string> = {
  sessionId: '会话',
  title: '标题',
  content: '内容',
  modelId: '模型',
  policy: '安全模式',
  mode: '下发方式',
  workdir: '工作目录',
}

/** 把管家工具的审批参数渲染成用户可读的键值对：sessionId 翻译成会话标题、枚举值翻译成中文，避免暴露技术 id / 英文枚举 */
function supervisorArgsSummary(args: Record<string, unknown>, sessions: SessionListItem[]): React.ReactNode {
  if (!args || Object.keys(args).length === 0) return <span style={{ color: 'var(--text-muted)' }}>（无参数）</span>
  const entries = Object.entries(args)
  return (
    <div>
      {entries.map(([k, v]) => {
        let display: string = prettyValue(v)
        if (k === 'sessionId') {
          const sid = String(v)
          const t = sessions.find((s) => s.id === sid)
          display = t ? `「${t.title}」` : `（未知会话 ${sid}）`
        } else if (k === 'policy') {
          display = ({ ask: '每次询问', workdir: '仅工作区内自动放行', never: '从不询问' } as Record<string, string>)[String(v)] ?? String(v)
        } else if (k === 'mode') {
          display = ({ insert: '追加（不打断）', queue: '排队（等当前任务结束）' } as Record<string, string>)[String(v)] ?? String(v)
        }
        return (
          <div key={k} style={{ marginBottom: 2 }}>
            <span style={{ color: 'var(--text-muted)' }}>{SUPERVISOR_ARG_LABELS[k] ?? k}：</span>
            <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>{display}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 会话管家窗口（主 Agent）：独立常驻的单会话聊天界面。
 * 只显示管家超级会话（sessionMap['supervisor']）的消息流，发送走 supervisorRun（IPC → runtime.runSupervisor）。
 * 输入框复用聊天窗口的 Composer（附件 / 模型 / 安全模式 / 麦克风 / 发送 完全一致）。
 */
export function SupervisorApp(): React.JSX.Element {
  // 卡顿优化（P0）：窄订阅替代全量 useUiStore()。仅订阅 supervisor 会话自身相关的窄字段，
  // 其他会话的工具步骤 / token / 审批 / 流式等高频变化不再触发管家整窗重渲染（浅比较不变的字段返回缓存引用）。
  const ui = useUiStoreSelector((s) => ({
    cur: s.sessionMap[SUPERVISOR_SID] ?? EMPTY_SESSION,
    curApproval: (s.approvalQueues[SUPERVISOR_SID] ?? [])[0] ?? null,
    curAsk: (s.askQueues[SUPERVISOR_SID] ?? [])[0] ?? null,
    capabilityApproval: s.capabilityApprovals[0] ?? null,
    models: s.models,
    selectedModel: s.selectedModel,
    loggedIn: s.loggedIn,
    // sessions 从订阅移除：仅 supervisorArgsSummary 用一次，改为 getUiStoreSnapshot() 按需读取
    // 避免其他会话 start/end 重建 sessions 数组时拖累管家整窗重渲染
    tokenStats: s.tokenStatsBySession[SUPERVISOR_SID] ?? null,
  }))
  const cur = ui.cur
  const streaming = useStreaming(SUPERVISOR_SID)
  const curApproval = ui.curApproval
  const curAsk = ui.curAsk
  const capabilityApproval = ui.capabilityApproval

  // 卡顿优化（P0）：流式正文 markdown 节流（对齐 ChatPlugin）。streaming.text 每帧都在变长，
  // 逐帧全量解析 ReactMarkdown 很费；这里每 120ms 才把最新文本写入 state 渲染一次。
  const streamTextRef = useRef(streaming.text)
  streamTextRef.current = streaming.text
  const lastRenderedTextRef = useRef('')
  const [streamedText, setStreamedText] = useState('')
  useEffect(() => {
    const iv = setInterval(() => {
      if (streamTextRef.current !== lastRenderedTextRef.current) {
        lastRenderedTextRef.current = streamTextRef.current
        setStreamedText(streamTextRef.current)
      }
    }, 120)
    return () => clearInterval(iv)
  }, [])

  const [isSpeaking, setIsSpeaking] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  // 能力级审批「本会话记住此授权」勾选（阶段3c remember）：用户允许时勾选则写 session 级授权白名单
  const [rememberCapability, setRememberCapability] = useState(false)
  // 卡顿优化（P1）：onPreviewImage useCallback 稳定化，避免 nodes 重建时所有消息 memo 失效
  const handlePreviewImage = useCallback((url: string) => setPreviewImage(url), [])
  const composerRef = useRef<SupervisorComposerHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 是否在底部：仅由滚动事件维护（对齐 ChatPlugin 已被验证正常的吸底写法）。
  // 初始为 true：窗口首次加载历史时（cur.items 从空 → 填充）自动滚到底部最新消息。
  const atBottomRef = useRef(true)

  // 用户滚动（滚轮/拖条/键盘）时更新「是否在底部」状态，供吸底 effect gate 用。
  const handleScroll = useCallback((): void => {
    const el = listRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  // 主题：订阅主进程广播，跟随聊天窗口切换（亮/暗实时同步）
  useThemeSync()

  // 管家窗口的主题切换入口：读取当前主题用于按钮图标，切换时写 localStorage + 应用 + 广播给所有窗口
  const [theme, setThemeMode] = useState<ThemeMode>(() => readTheme())
  useEffect(() => {
    const off = window.shanhai?.onThemeChange((t) => setThemeMode(t))
    return off
  }, [])
  const toggleTheme = useCallback((): void => {
    const next: ThemeMode = theme === 'light' ? 'dark' : 'light'
    setThemeMode(next)
    applyTheme(next)
    try {
      localStorage.setItem('shanhai-theme', next)
    } catch {
      /* localStorage 不可用时静默忽略 */
    }
    window.shanhai?.setTheme(next)
  }, [theme])

  // 启动时加载管家会话历史（跨重启保留）+ 管家工作目录
  useEffect(() => {
    const api = window.shanhai
    if (!api) return
    void api.getSupervisorHistory().then((history) => {
      patchSession({ items: historyToItems(history) })
    })
    // 管家会话 token 用量：主动拉取初始累计值（累计值从 supervisor 会话事件日志恢复），后续由 onTokenStats 广播实时更新
    void api.getTokenStats(SUPERVISOR_SID).then((s) => patchUiStore({ tokenStatsBySession: { [SUPERVISOR_SID]: s } })).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const patchSession = useCallback((patch: Partial<SessionUIState> | ((s: SessionUIState) => Partial<SessionUIState>)): void => {
    const snap = getUiStoreSnapshot()
    const existing = snap.sessionMap[SUPERVISOR_SID]
    const base = existing ?? EMPTY_SESSION
    // 字段级 patch：只发送 patch 显式指定的字段，不展开已有 base（否则会把本地旧的 items 整体覆盖到主进程，
    // 覆盖掉 onSessionActivity('end') 刚重建的含正文 items，导致「执行完正文消失、重启后才出现」的竞态）。
    const next = typeof patch === 'function' ? patch(base) : patch
    // 会话首次写入：补全 EMPTY_SESSION 完整字段（否则 deepMerge 会把残缺对象写入 sessionMap，白屏）
    patchUiStore({ sessionMap: { [SUPERVISOR_SID]: existing ? next : { ...EMPTY_SESSION, ...next } } })
  }, [])

  // 吸底跟随：内容变化时只要用户在底部就滚到底（对齐 ChatPlugin 已被验证正常的写法）。
  // 用 atBottomRef（滚动事件维护）gate，而非实时算 scrollTop：
  // —— atBottomRef 初始为 true → 首次加载历史（cur.items 从空→填充）时自动滚到底部最新消息；
  // —— 用户向上滚动后 handleScroll 把 atBottomRef 置 false，后续内容变化不再强行拽回底部。
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
    // 依赖 streamedText（120ms 节流后的 state）而非 streaming.text/reasoning（每帧变长），
    // 避免 rAF 期间每帧触发同步 reflow（scrollTop = scrollHeight 强制 layout）
  }, [cur.items, streamedText, curApproval])

  /** 任务完成自动语音播报：受「语音播报」开关控制，清洗 markdown 后截断播报，播报期间显示 3D 特效 */
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
      setIsSpeaking(false)
    }
  }

  /** 响应管家会话的审批请求：通知 runtime 后由 onApprovalResolved 事件统一移除（否则弹窗会一直显示） */
  async function respondApproval(outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const req = (getUiStoreSnapshot().approvalQueues[SUPERVISOR_SID] ?? [])[0]
    if (!req) return
    await window.shanhai?.respondApproval(outcome, req.id)
    // 弹窗关闭由 runtime 的 onApprovalResolved 事件统一驱动（ui-store removeApprovalRequest），
    // 此处不再手动 patchUiStore 移除，避免与 resolved 事件双重移除。
  }

  /** 响应管家会话的 AI 提问：通知 runtime 后由 onAskResolved 事件统一移除 */
  async function respondAsk(answer: string): Promise<void> {
    const req = (getUiStoreSnapshot().askQueues[SUPERVISOR_SID] ?? [])[0]
    if (!req) return
    await window.shanhai?.respondAsk(req.id, answer)
    // 弹窗关闭由 runtime 的 onAskResolved 事件统一驱动（ui-store removeAskRequest），
    // 此处不再手动 patchUiStore 移除，避免与 resolved 事件双重移除。
  }

  /** 响应能力级审批（插件跨插件调用 write/destructive 能力）：允许/拒绝后由 onCapabilityApprovalResolved 事件统一移除 */
  function respondCapabilityApproval(approved: boolean, rememberForSession = false): void {
    if (!capabilityApproval) return
    void window.shanhai?.respondCapabilityApproval(capabilityApproval.requestId, approved, rememberForSession)
    // 弹窗关闭由 runtime 的 onCapabilityApprovalResolved 事件统一驱动（ui-store removeCapabilityApprovalRequest），
    // 此处不再手动 patchUiStore 移除，避免与 resolved 事件双重移除。
  }

  /** 取消管家会话的 AI 提问/选择：通知 runtime 取消（resolve 为取消标记），由 onAskResolved 事件统一移除 */
  async function cancelAsk(): Promise<void> {
    const req = (getUiStoreSnapshot().askQueues[SUPERVISOR_SID] ?? [])[0]
    if (!req) return
    await window.shanhai?.cancelAsk(req.id)
    // 弹窗关闭由 runtime 的 onAskResolved 事件统一驱动（ui-store removeAskRequest），
    // 此处不再手动 patchUiStore 移除，避免与 resolved 事件双重移除。
  }

  const stopSend = useCallback((): void => {
    patchSession({ busy: false, streaming: '', streamingReasoning: '' })
    void window.shanhai?.stop()
  }, [patchSession])

  /** 重新发送：截断到该用户消息重新生成（对齐聊天窗口 resendMessage，直接重发不填回输入框） */
  const resendMessage = useCallback((userIndex: number): void => {
    const sid = SUPERVISOR_SID
    // 立即从该节点截断视图：保留该用户消息（含），移除其后的所有回复/工具步骤，再走后端截断 + 重跑
    patchSession((s) => {
      const cutAt = userItemIndex(s.items, userIndex)
      const items = cutAt >= 0 ? s.items.slice(0, cutAt + 1) : s.items
      return { items, busy: true, streaming: '', streamingReasoning: '', turnStartTs: Date.now() }
    })
    void window.shanhai
      ?.resend(sid, userIndex)
      .then(() => {
        void window.shanhai?.getSupervisorHistory().then((history) => {
          patchSession({ items: historyToItems(history), streaming: '', streamingReasoning: '', busy: false })
        })
      })
      .catch((err) => {
        patchSession((s) => ({
          items: [...s.items, { kind: 'assistant', content: `错误：${err instanceof Error ? err.message : String(err)}`, turnSeq: s.items.filter((it) => it.kind === 'user').length, turnDuration: 0 }],
          streaming: '',
          streamingReasoning: '',
          busy: false,
        }))
      })
  }, [patchSession])

  /** 编辑后重发：截断到该消息，用新内容重新生成（对齐聊天窗口 editResend） */
  const editResend = useCallback((userIndex: number, newContent: string): void => {
    const sid = SUPERVISOR_SID
    patchSession((s) => {
      const cutAt = userItemIndex(s.items, userIndex)
      const target = cutAt >= 0 ? s.items[cutAt] : undefined
      if (!target || target.kind !== 'user') return { busy: true, streaming: '', streamingReasoning: '', turnStartTs: Date.now() }
      const items = [...s.items.slice(0, cutAt), { ...target, content: newContent }]
      return { items, busy: true, streaming: '', streamingReasoning: '', turnStartTs: Date.now() }
    })
    void window.shanhai
      ?.resend(sid, userIndex, newContent)
      .then(() => {
        void window.shanhai?.getSupervisorHistory().then((history) => {
          patchSession({ items: historyToItems(history), streaming: '', streamingReasoning: '', busy: false })
        })
      })
      .catch((err) => {
        patchSession((s) => ({
          items: [...s.items, { kind: 'assistant', content: `错误：${err instanceof Error ? err.message : String(err)}`, turnSeq: s.items.filter((it) => it.kind === 'user').length, turnDuration: 0 }],
          streaming: '',
          streamingReasoning: '',
          busy: false,
        }))
      })
  }, [patchSession])

  /** 发送消息给管家（等同用户在管家窗口输入）：处理附件后调 supervisorRun */
  const send = useCallback(async (): Promise<void> => {
    const input = composerRef.current?.getInput() ?? ''
    const attachments = composerRef.current?.getAttachments() ?? []
    const text = input.trim()
    if (!text || cur.busy) return
    if (attachments.some((a) => a.type === 'image' && a.uploadStatus !== 'done')) return
    const images = attachments.filter((a) => a.type === 'image').map((a) => a.dataUrl)
    const parts: ContentPart[] = []
    const fileNotes: string[] = []
    for (const a of attachments) {
      if (a.type === 'image') {
        const url = a.url
        if (!url) continue
        parts.push({ type: 'image_url', image_url: { url } })
        continue
      }
      if (a.type === 'file') {
        const base64 = a.dataUrl.replace(/^data:[^;]+;base64,/, '')
        try {
          const savedPath = (await window.shanhai?.saveUploadedFile(a.name, base64)) ?? a.name
          fileNotes.push(`${a.name}（${formatBytes(a.size)}）→ ${savedPath}`)
        } catch {
          fileNotes.push(`${a.name}（${formatBytes(a.size)}）`)
        }
        continue
      }
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
    const finalText = fileNotes.length > 0 ? `${text}${text ? '\n\n' : ''}[已附加文件]\n${fileNotes.join('\n')}` : text
    composerRef.current?.clearInput()
    const startTs = Date.now()
    patchSession((s) => ({
      items: [...s.items, { kind: 'user', content: text, images, turnSeq: s.items.filter((it) => it.kind === 'user').length + 1 }],
      streaming: '',
      streamingReasoning: '',
      busy: true,
      turnStartTs: startTs,
    }))
    // 竞态修复：interrupted/catch 分支追加 assistant 气泡前，先从主进程拉取 onSessionActivity('end') 已重建的权威 items，
    // 避免用本地滞后的 s.items 覆盖主进程刚重建的含正文 items（「执行完正文消失」竞态）。
    const authoritativeItems = async (): Promise<ChatItem[] | null> => {
      try {
        const history = await window.shanhai?.getSupervisorHistory()
        return history ? historyToItems(history) : null
      } catch {
        return null
      }
    }
    let interrupted = false
    try {
      const result = (await window.shanhai?.supervisorRun(finalText, parts)) ?? ''
      interrupted = result.startsWith('（已中断')
      if (!interrupted && result.trim()) void speakResult(result)
      // 正常完成：assistant 正文由主进程 ui-store 的 onSessionActivity('end') 用 getSessionHistory 重建，
      // 这里不再重复 push（否则会出现「带工具调用」+「纯正文」两个重复气泡）。仅中断时补「已中断」提示气泡。
      if (interrupted) {
        const base = (await authoritativeItems()) ?? getUiStoreSnapshot().sessionMap[SUPERVISOR_SID]?.items ?? []
        patchSession({ items: [...base, { kind: 'assistant', content: result, turnSeq: base.filter((it) => it.kind === 'user').length, turnDuration: Date.now() - startTs }] })
      }
    } catch (err) {
      const base = (await authoritativeItems()) ?? getUiStoreSnapshot().sessionMap[SUPERVISOR_SID]?.items ?? []
      patchSession({ items: [...base, { kind: 'assistant', content: `错误：${err instanceof Error ? err.message : String(err)}`, turnSeq: base.filter((it) => it.kind === 'user').length, turnDuration: Date.now() - startTs }] })
    } finally {
      patchSession({ busy: false })
    }
  }, [cur.busy, patchSession])

  // 消息流渲染（按轮次分组：user 后收集 tool，遇 assistant 聚合进回复气泡）
  // 用 useMemo 缓存历史消息节点：streaming 变化时 items/busy/resend/edit 引用均不变，返回缓存的 nodes，
  // 避免每个 token 都重建全部历史消息 VNode（React 对相同 element 引用做 bailout）。
  const { nodes, pendingTools } = useMemo(() => {
    const nodes: React.ReactNode[] = []
    let userIdx = 0
    let toolBuffer: import('../types').ToolTrace[] = []
    let seq = 0
    const flushTools = (keyBase: string): void => {
      if (toolBuffer.length === 0) return
      const tools = toolBuffer
      toolBuffer = []
      nodes.push(
        <div key={`tools-${keyBase}`} style={HISTORY_BLOCK_STYLE}>
          {tools.map((t) => (
            <ToolStep key={t.callId} trace={t} />
          ))}
        </div>,
      )
    }
    for (const it of cur.items as ChatItem[]) {
      if (it.kind === 'user') {
        flushTools(`u${seq}`)
        const idx = userIdx++
        nodes.push(
          <div key={`u${seq++}`} style={HISTORY_BLOCK_STYLE}>
            <UserMessage
              content={it.content}
              images={it.images}
              userIndex={idx}
              busy={cur.busy}
              pending={it.pending}
              onResend={resendMessage}
              onEditResend={editResend}
              onPreviewImage={handlePreviewImage}
            />
          </div>,
        )
      } else if (it.kind === 'assistant') {
        const tools = toolBuffer
        toolBuffer = []
        nodes.push(
          <div key={`a${seq++}`} style={HISTORY_BLOCK_STYLE}>
            <AssistantMessage
              content={it.content}
              reasoningContent={it.reasoningContent}
              toolSteps={tools}
              turnDuration={it.turnDuration}
              onPreviewImage={handlePreviewImage}
            />
          </div>,
        )
      } else {
        toolBuffer.push(it.trace)
      }
    }
    if (!cur.busy) flushTools('tail')
    return { nodes, pendingTools: toolBuffer }
  }, [cur.items, cur.busy, resendMessage, editResend, handlePreviewImage])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--bg-app)',
        color: 'var(--text)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <WindowTitleBar
        icon={<IconMonitor />}
        title="会话管家"
        subtitle="主 Agent · 监控与调度所有会话"
        tone="purple"
        onClose={() => void window.shanhai?.hideSupervisorToBubble()}
        actions={
          <button
            onClick={toggleTheme}
            title={theme === 'light' ? '切换到暗色模式' : '切换到亮色模式'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
          >
            {theme === 'light' ? <IconMoon /> : <IconSun />}
          </button>
        }
      />

      <VirtualList
        containerRef={listRef}
        items={nodes}
        onScroll={handleScroll}
        isEmpty={cur.items.length === 0 && !cur.busy}
        empty={
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 120, color: 'var(--text-muted)', fontSize: 13, gap: 8 }}>
            <span style={{ transform: 'scale(1.8)', display: 'inline-flex', color: 'var(--accent)' }}>
              <IconMonitor />
            </span>
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>我是会话管家</div>
            <div>可以问我「现在有哪些会话在干活」「某个会话做到哪了」，或让我「给会话X新增需求」。</div>
          </div>
        }
        footer={
          cur.busy ? (
            <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <div style={AI_BUBBLE_STYLE}>
                {/* 实时耗时 + 步数统计：任务执行中每秒跳动显示耗时，并实时统计已执行步数 */}
                {(cur.turnStartTs != null || pendingTools.length > 0) && (
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>
                    {cur.turnStartTs != null && (
                      <>
                        耗时 <LiveDuration startTs={cur.turnStartTs} />
                      </>
                    )}
                    <StepStats tools={pendingTools} />
                  </div>
                )}
                {/* 当前轮已执行的工具步骤（实时，与聊天窗口一致） */}
                {pendingTools.length > 0 && (
                  <div style={{ margin: '0 0 2px' }}>
                    {pendingTools.map((t) => (
                      <ToolStep key={t.callId} trace={t} />
                    ))}
                  </div>
                )}
                {streaming.reasoning && <ReasoningBlock content={streaming.reasoning} streaming />}
                {streamedText && (
                  <div style={{ minWidth: 0, maxWidth: '100%', overflowX: 'auto' }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents((url) => setPreviewImage(url))}>
                      {normalizeTreeBlocks(stripWrappedRecordTag(streamedText))}
                    </ReactMarkdown>
                    <span style={{ animation: 'blink 1s step-start infinite' }}>▌</span>
                  </div>
                )}
                <div style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                  思考中
                  <ThinkingDots />
                </div>
              </div>
            </div>
          ) : null
        }
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 16,
          background: 'var(--bg-sidebar)',
          contain: 'layout',
        }}
      />

      {/* 输入区：自包含 SupervisorComposer（附件 / 模型 / 安全模式 / 麦克风 / 发送），键入只重渲染本子树 */}
      <SupervisorComposer
        ref={composerRef}
        busy={cur.busy}
        models={ui.models}
        defaultSelectedModel={ui.selectedModel}
        loggedIn={ui.loggedIn}
        setPreviewImage={setPreviewImage}
        onSend={send}
        onStop={stopSend}
      />

      {/* token 用量状态栏：与聊天窗口一致（累计 / 本轮 / 缓存命中 / 轮次 / 上下文占比），数据源为管家会话（supervisor） */}
      <TokenStatusBar stats={ui.tokenStats ?? null} />

      {/* 审批弹窗（管家会话的工具审批） */}
      {curApproval && (
        <div
          style={{
            position: 'absolute',
            bottom: 158,
            left: 16,
            right: 16,
            padding: 14,
            borderRadius: 12,
            border: '1px solid var(--tint-red-strong)',
            background: 'var(--tint-red)',
            fontSize: 13,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>
            <IconWarn />
            需要你确认以下操作
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
            {toolDisplayName(curApproval.toolName, curApproval.args)}
            <span style={{ color: 'var(--tint-red-strong)', marginLeft: 6 }}>（{riskLevelLabel(curApproval.riskLevel)}）</span>
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 10, fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            {supervisorArgsSummary(curApproval.args, getUiStoreSnapshot().sessions ?? [])}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void respondApproval('allowed-once')} style={btn('var(--accent)', '#fff')}>
              允许一次
            </button>
            <button onClick={() => void respondApproval('rejected')} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
              拒绝
            </button>
          </div>
        </div>
      )}

      {/* 能力级审批卡片（插件跨插件调用 write/destructive 能力，如 network:http POST / filesystem 写） */}
      {capabilityApproval && (
        <div
          style={{
            position: 'absolute',
            bottom: 158,
            left: 16,
            right: 16,
            padding: 14,
            borderRadius: 12,
            border: '1px solid var(--tint-orange-strong, var(--tint-red-strong))',
            background: 'var(--tint-orange, var(--tint-red))',
            fontSize: 13,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            zIndex: 20,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>
            <IconWarn />
            插件能力调用需要确认
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>
            插件 <b style={{ color: 'var(--text)' }}>{capabilityApproval.callerPkgId}</b> 请求调用能力：
            <b style={{ color: 'var(--text)', marginLeft: 6 }}>{capabilityApproval.capability}</b>
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 10, fontSize: 12 }}>
            风险等级：<span style={{ color: 'var(--tint-red-strong)', fontWeight: 600 }}>{capabilityApproval.risk}</span>
            {capabilityApproval.sessionId && (
              <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>会话 {capabilityApproval.sessionId}</span>
            )}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={rememberCapability}
              onChange={(e) => setRememberCapability(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            本次会话内记住此授权（同类能力不再逐次弹窗）
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => respondCapabilityApproval(true, rememberCapability)} style={btn('var(--accent)', '#fff')}>
              允许
            </button>
            <button onClick={() => respondCapabilityApproval(false)} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
              拒绝
            </button>
          </div>
        </div>
      )}

      {/* AI 提问卡片 / 会话选择器 / 模型选择器（按 kind 分派） */}
      {curAsk && curAsk.kind === 'session-picker' ? (
        <SessionPicker req={curAsk} onSubmit={(answer) => void respondAsk(answer)} onCancel={() => void cancelAsk()} />
      ) : curAsk && curAsk.kind === 'model-picker' ? (
        <ModelPicker req={curAsk} onSubmit={(answer) => void respondAsk(answer)} onCancel={() => void cancelAsk()} />
      ) : curAsk ? (
        <AskCard req={curAsk} onSubmit={(answer) => void respondAsk(answer)} onCancel={() => void cancelAsk()} />
      ) : null}

      {/* 语音播报量子粒子特效浮层：portal 挂到 body，绝对置顶居中、点击穿透；播报结束自动卸载 */}
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

      {/* 图片预览遮罩层：与聊天窗口一致，点击消息内图片放大预览，点背景或 Esc 关闭 */}
      {previewImage && <ImagePreview src={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  )
}
