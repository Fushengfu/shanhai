import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { getUiStoreSnapshot, patchUiStore, useUiStore, useStreaming } from '../store-client'
import { EMPTY_SESSION, type AttachmentItem, type ChatItem, type ContentPart, type HistoryItem, type SessionListItem, type SessionUIState } from '../types'
import { WindowTitleBar } from '../components/WindowTitleBar'
import { AiOrb } from '../components/AiOrb'
import { AssistantMessage } from '../components/AssistantMessage'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { makeMarkdownComponents, normalizeTreeBlocks } from '../components/Markdown'
import { ImagePreview } from '../components/ImagePreview'
import { UserMessage } from '../components/UserMessage'
import { ToolStep, StepStats, toolDisplayName, riskLevelLabel } from '../components/ToolStep'
import { ReasoningBlock } from '../components/ReasoningBlock'
import { AskCard } from '../components/AskCard'
import { SessionPicker } from '../components/SessionPicker'
import { ModelPicker } from '../components/ModelPicker'
import { Composer } from '../components/Composer'
import { TokenStatusBar } from '../components/TokenStatusBar'
import { IconMonitor, IconWarn, IconMoon, IconSun } from '../components/icons'
import { btn, formatBytes, prettyValue, readFileAsDataUrl, LiveDuration, ThinkingDots } from '../components/ui'
import { useThemeSync, readTheme, applyTheme, type ThemeMode } from '../theme'

/** 会话管家超级会话的固定 id（与 runtime 的 SUPERVISOR_ID 一致） */
const SUPERVISOR_SID = 'supervisor'

/** AI 回复气泡通用底样（与 ChatPlugin 保持一致） */
const AI_BUBBLE_STYLE: React.CSSProperties = {
  maxWidth: '85%',
  padding: '10px 14px',
  borderRadius: 16,
  borderTopLeftRadius: 4,
  background: 'var(--bg-panel)',
  boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
  fontSize: 14,
  lineHeight: 1.65,
  color: 'var(--text)',
  overflowWrap: 'break-word',
  wordBreak: 'break-word',
  userSelect: 'text',
  WebkitUserSelect: 'text',
}

/** PCM(Float32 16kHz) → 16-bit 单声道 PCM 的 base64（与聊天窗口一致） */
function pcmToBase64(pcm: Float32Array): string {
  const int16 = new Int16Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] ?? 0))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(int16.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0)
  return btoa(bin)
}

/** 计算一帧 PCM 的均方根能量（RMS），用于语音活动检测（VAD） */
function audioRms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / frame.length)
}

/** 把后端历史消息（HistoryItem[]）转换为消息流 items（ChatItem[]）：tool-result 合并到同 callId 的 tool-call */
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
  const ui = useUiStore()
  const cur = ui.sessionMap[SUPERVISOR_SID] ?? EMPTY_SESSION
  const streaming = useStreaming(SUPERVISOR_SID)
  const curApproval = (ui.approvalQueues[SUPERVISOR_SID] ?? [])[0] ?? null
  const curAsk = (ui.askQueues[SUPERVISOR_SID] ?? [])[0] ?? null

  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [recording, setRecording] = useState(false)
  const [voiceNotice, setVoiceNotice] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  /** 管家自己的模型 / 安全模式（supervisor 会话级，独立于其他会话与全局） */
  const [supervisorModel, setSupervisorModel] = useState('')
  const [supervisorApproval, setSupervisorApproval] = useState<'ask' | 'workdir' | 'never'>('ask')
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const approvalMenuRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const mediaRecorderRef = useRef<{ stop: () => void } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

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
    void api.supervisorGetModel().then((m) => setSupervisorModel(m)).catch(() => undefined)
    void api.supervisorGetApproval().then((p) => setSupervisorApproval(p)).catch(() => undefined)
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

  // 滚动跟随：用户是否在底部，仅由滚动事件维护
  const handleScroll = (): void => {
    const el = listRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [cur.items, streaming.text, streaming.reasoning, curApproval])

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

  /** 生成附件唯一 id */
  const genId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  /** 图片附件自动上传云存储：拿到 https 链接后回填到对应附件 */
  function uploadImageAttachment(id: string, dataUrl: string, mime: string): void {
    void (async () => {
      const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
      try {
        const url = (await window.shanhai?.uploadImage(base64, mime)) ?? null
        setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, uploadStatus: url ? 'done' : 'error', url: url ?? undefined } : x)))
      } catch {
        setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, uploadStatus: 'error' } : x)))
      }
    })()
  }

  /** 重新上传某张上传失败的图片附件 */
  function retryImageUpload(id: string): void {
    const a = attachments.find((x) => x.id === id)
    if (!a || a.type !== 'image') return
    setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, uploadStatus: 'uploading', url: undefined } : x)))
    uploadImageAttachment(id, a.dataUrl, a.mime)
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
      if (type === 'image') {
        const id = genId()
        setAttachments((prev) => [...prev, { id, type, name: file.name, dataUrl, mime: file.type, size: file.size, uploadStatus: 'uploading' }])
        uploadImageAttachment(id, dataUrl, file.type || 'image/png')
      } else {
        setAttachments((prev) => [...prev, { id: genId(), type, name: file.name, dataUrl, mime: file.type, size: file.size }])
      }
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
          const id = genId()
          setAttachments((prev) => [...prev, { id, type: 'image', name: `pasted-${Date.now()}.png`, dataUrl, mime: file.type || 'image/png', size: file.size, uploadStatus: 'uploading' }])
          uploadImageAttachment(id, dataUrl, file.type || 'image/png')
        }
      }
    }
  }

  /** 语音输入：点击开始录音，再次点击停止；录音结束交后端 AI 识别，结果填入输入框（与聊天窗口一致） */
  async function toggleRecording(): Promise<void> {
    if (recording) {
      mediaRecorderRef.current?.stop()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioCtx = new AudioContext({ sampleRate: 16000 })
      const source = audioCtx.createMediaStreamSource(stream)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []
      const FRAME_SECONDS = 4096 / 16000
      const TRAILING_SILENCE_FRAMES = 12
      const NOISE_ESTIMATE_FRAMES = 6
      let noiseFloor = 0
      let totalFrames = 0
      let lastVoiceFrame = -1
      let consecutiveSilenceFrames = 0
      let stopped = false

      const finishRecording = (trigger: 'manual' | 'auto'): void => {
        if (stopped) return
        stopped = true
        try {
          processor.disconnect()
          source.disconnect()
          stream.getTracks().forEach((t) => t.stop())
        } catch {
          // 忽略断开异常
        }
        void audioCtx.close().catch(() => undefined)
        void (async () => {
          if (chunks.length === 0) {
            setRecording(false)
            return
          }
          try {
            if (lastVoiceFrame < 0) {
              setVoiceNotice('未检测到有效语音，请重试')
              return
            }
            let keepFrames = totalFrames
            if (trigger === 'auto') {
              keepFrames = lastVoiceFrame + 1
              setVoiceNotice(`检测到约 ${(consecutiveSilenceFrames * FRAME_SECONDS).toFixed(1)} 秒静音，已自动结束并提交有效语音`)
            } else if (totalFrames - 1 - lastVoiceFrame >= TRAILING_SILENCE_FRAMES) {
              keepFrames = lastVoiceFrame + 1
              setVoiceNotice(`已自动截断结尾 ${((totalFrames - keepFrames) * FRAME_SECONDS).toFixed(1)} 秒静音`)
            }
            let total = 0
            for (let i = 0; i < keepFrames; i++) total += chunks[i]?.length ?? 0
            const pcm = new Float32Array(total)
            let off = 0
            for (let i = 0; i < keepFrames; i++) {
              const c = chunks[i]
              if (c) {
                pcm.set(c, off)
                off += c.length
              }
            }
            const pcmBase64 = pcmToBase64(pcm)
            const text = (await window.shanhai?.transcribeAudio(pcmBase64)) ?? ''
            if (text.trim()) setInput((prev) => (prev ? `${prev}${text.trim()}` : text.trim()))
          } catch (err) {
            console.error('语音识别失败', err)
          } finally {
            setRecording(false)
          }
        })()
      }

      processor.onaudioprocess = (e) => {
        const frame = new Float32Array(e.inputBuffer.getChannelData(0))
        chunks.push(frame)
        const r = audioRms(frame)
        if (totalFrames < NOISE_ESTIMATE_FRAMES) {
          noiseFloor = (noiseFloor * totalFrames + r) / (totalFrames + 1)
          totalFrames++
          return
        }
        if (r > Math.max(noiseFloor * 3, 0.012)) {
          lastVoiceFrame = totalFrames
          consecutiveSilenceFrames = 0
        } else {
          consecutiveSilenceFrames++
          if (lastVoiceFrame >= 0 && consecutiveSilenceFrames >= TRAILING_SILENCE_FRAMES) {
            finishRecording('auto')
            return
          }
        }
        totalFrames++
      }
      source.connect(processor)
      processor.connect(audioCtx.destination)

      mediaRecorderRef.current = { stop: () => finishRecording('manual') }
      setRecording(true)
    } catch (err) {
      console.error('麦克风不可用或录音失败', err)
      setRecording(false)
    }
  }

  /** 切换管家自己的模型：只影响 supervisor 会话，不碰全局默认模型、不碰其他会话 */
  function selectModel(id: string): void {
    setSupervisorModel(id)
    setModelMenuOpen(false)
    void window.shanhai?.supervisorSetModel(id)
  }

  /** 切换管家自己的安全模式：只影响 supervisor 会话，不碰全局、不碰其他会话 */
  function switchApprovalPolicy(policy: 'ask' | 'workdir' | 'never'): void {
    setSupervisorApproval(policy)
    setApprovalMenuOpen(false)
    void window.shanhai?.supervisorSetApproval(policy)
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

  /** 取消管家会话的 AI 提问/选择：通知 runtime 取消（resolve 为取消标记），由 onAskResolved 事件统一移除 */
  async function cancelAsk(): Promise<void> {
    const req = (getUiStoreSnapshot().askQueues[SUPERVISOR_SID] ?? [])[0]
    if (!req) return
    await window.shanhai?.cancelAsk(req.id)
    // 弹窗关闭由 runtime 的 onAskResolved 事件统一驱动（ui-store removeAskRequest），
    // 此处不再手动 patchUiStore 移除，避免与 resolved 事件双重移除。
  }

  function stopSend(): void {
    patchSession({ busy: false, streaming: '', streamingReasoning: '' })
    void window.shanhai?.stop()
  }

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
  async function send(): Promise<void> {
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
    setInput('')
    setAttachments([])
    const startTs = Date.now()
    patchSession((s) => ({
      items: [...s.items, { kind: 'user', content: text, images, turnSeq: s.items.filter((it) => it.kind === 'user').length + 1 }],
      streaming: '',
      streamingReasoning: '',
      busy: true,
      turnStartTs: startTs,
    }))
    let interrupted = false
    try {
      const result = (await window.shanhai?.supervisorRun(finalText, parts)) ?? ''
      interrupted = result.startsWith('（已中断')
      if (!interrupted && result.trim()) void speakResult(result)
      // 正常完成：assistant 正文由主进程 ui-store 的 onSessionActivity('end') 用 getSessionHistory 重建，
      // 这里不再重复 push（否则会出现「带工具调用」+「纯正文」两个重复气泡）。仅中断时补「已中断」提示气泡。
      if (interrupted) {
        patchSession((s) => ({
          items: [
            ...s.items,
            { kind: 'assistant', content: result, turnSeq: s.items.filter((it) => it.kind === 'user').length, turnDuration: Date.now() - startTs },
          ],
        }))
      }
    } catch (err) {
      patchSession((s) => ({
        items: [
          ...s.items,
          { kind: 'assistant', content: `错误：${err instanceof Error ? err.message : String(err)}`, turnSeq: s.items.filter((it) => it.kind === 'user').length, turnDuration: Date.now() - startTs },
        ],
      }))
    } finally {
      patchSession({ busy: false })
    }
  }

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
        <div key={`tools-${keyBase}`}>
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
          <UserMessage
            key={`u${seq++}`}
            content={it.content}
            images={it.images}
            userIndex={idx}
            busy={cur.busy}
            pending={it.pending}
            onResend={resendMessage}
            onEditResend={editResend}
            onPreviewImage={(url) => setPreviewImage(url)}
          />,
        )
      } else if (it.kind === 'assistant') {
        const tools = toolBuffer
        toolBuffer = []
        nodes.push(
          <AssistantMessage
            key={`a${seq++}`}
            content={it.content}
            reasoningContent={it.reasoningContent}
            toolSteps={tools}
            turnDuration={it.turnDuration}
            onPreviewImage={(url) => setPreviewImage(url)}
          />,
        )
      } else {
        toolBuffer.push(it.trace)
      }
    }
    if (!cur.busy) flushTools('tail')
    return { nodes, pendingTools: toolBuffer }
  }, [cur.items, cur.busy, resendMessage, editResend, setPreviewImage])

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

      <div
        ref={listRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 16,
          background: 'var(--bg-sidebar)',
          position: 'relative',
        }}
      >
        {cur.items.length === 0 && !cur.busy ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 120, color: 'var(--text-muted)', fontSize: 13, gap: 8 }}>
            <span style={{ transform: 'scale(1.8)', display: 'inline-flex', color: 'var(--accent)' }}>
              <IconMonitor />
            </span>
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>我是会话管家</div>
            <div>可以问我「现在有哪些会话在干活」「某个会话做到哪了」，或让我「给会话X新增需求」。</div>
          </div>
        ) : (
          <>
            {nodes}
            {cur.busy && (
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
                  {streaming.text && (
                    <div style={{ minWidth: 0, maxWidth: '100%', overflowX: 'auto' }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents((url) => setPreviewImage(url))}>
                        {normalizeTreeBlocks(streaming.text)}
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
            )}
          </>
        )}
      </div>

      {/* 输入区：复用聊天窗口 Composer（附件 / 模型 / 工作目录 / 安全模式 / 麦克风 / 发送 完全一致） */}
      <Composer
        isEmpty={false}
        attachments={attachments}
        setAttachments={setAttachments}
        retryImageUpload={retryImageUpload}
        setPreviewImage={setPreviewImage}
        fileRef={fileRef}
        handleFileSelect={handleFileSelect}
        queueCount={0}
        voiceNotice={voiceNotice}
        input={input}
        setInput={setInput}
        isComposingRef={isComposingRef}
        handlePaste={handlePaste}
        modelMenuRef={modelMenuRef}
        modelMenuOpen={modelMenuOpen}
        setModelMenuOpen={setModelMenuOpen}
        models={ui.models}
        selectedModel={supervisorModel || ui.selectedModel}
        loggedIn={ui.loggedIn}
        selectModel={selectModel}
        showWorkdir={false}
        approvalMenuRef={approvalMenuRef}
        approvalMenuOpen={approvalMenuOpen}
        setApprovalMenuOpen={setApprovalMenuOpen}
        approvalPolicy={supervisorApproval}
        switchApprovalPolicy={switchApprovalPolicy}
        recording={recording}
        toggleRecording={toggleRecording}
        busy={cur.busy}
        send={send}
        stopSend={stopSend}
      />

      {/* token 用量状态栏：与聊天窗口一致（累计 / 本轮 / 缓存命中 / 轮次 / 上下文占比），数据源为管家会话（supervisor） */}
      <TokenStatusBar stats={ui.tokenStatsBySession[SUPERVISOR_SID] ?? null} />

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
            {supervisorArgsSummary(curApproval.args, ui.sessions)}
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
