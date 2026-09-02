import * as React from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Composer } from './Composer'
import type { AttachmentItem, GatewayModel } from '../types'
import { readFileAsDataUrl } from './ui'

/**
 * 聊天窗口输入区（自包含）：内部持有 input / attachments / recording / voiceNotice / 菜单开关等高频输入态，
 * 通过 React.memo + 自持 state 让「每次键入」只重渲染本子树，不再触发 App（含 {history.nodes} 历史消息树）整窗重渲染。
 *
 * 与主管家（SupervisorComposer）同构，唯一区别：聊天窗口的模型 / 安全模式 / 工作目录是全局会话级（由 App 持有并
 * 通过 props 传入），而非本组件内部独立状态；此外草稿恢复 / 新建清空 / 发送清空通过 `seed`（外部重置信号）+ `composerRef`
 * （最新输入缓存的真值）与 App 通信。
 */

export interface ChatComposerSeed {
  /** 外部重置信号自增序号：变化即触发本组件用 seed.input/attachments 重新同步自身输入态 */
  seq: number
  input: string
  attachments: AttachmentItem[]
}

/** Composer 当前输入的真值缓存（App 的 send 从这里读，避免 input/attachments 悬挂在 App 顶层触发整窗重渲染） */
export interface ChatComposerState {
  input: string
  attachments: AttachmentItem[]
}

export interface ChatComposerProps {
  busy: boolean
  isEmpty: boolean
  models: GatewayModel[]
  selectedModel: string
  loggedIn: boolean
  approvalPolicy: 'ask' | 'workdir' | 'never'
  workDir: string
  workDirName: string
  queueCount: number
  setPreviewImage: (v: string | null) => void
  selectModel: (id: string) => void
  switchApprovalPolicy: (policy: 'ask' | 'workdir' | 'never') => void
  pickWorkdir: () => Promise<void>
  send: () => Promise<void>
  stopSend: () => void
  /** App 侧创建的真值缓存，本组件每次 render 时同步最新 input/attachments 进去 */
  composerRef: React.MutableRefObject<ChatComposerState>
  /** 外部重置信号（草稿恢复 / 新建清空 / 发送清空） */
  seed: ChatComposerSeed
}

/** PCM(Float32 16kHz) → 16-bit 单声道 PCM 的 base64 */
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

/** 计算一帧 PCM 的均方根能量（RMS） */
function audioRms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / frame.length)
}

const ChatComposerInner = memo(function ChatComposerInner(p: ChatComposerProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [recording, setRecording] = useState(false)
  const [voiceNotice, setVoiceNotice] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const approvalMenuRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const mediaRecorderRef = useRef<{ stop: () => void } | null>(null)

  // render 期间同步最新输入到外部 composerRef（App 的 send 从中读取）。为何不用 useEffect：
  // useEffect 在 commit 后异步执行，用户「输入完成后立即按 Enter 发送」时可能还没同步最后一字；
  // render 期间同步则保证任何已完成 render 的最新值都对后续事件立即可见。此写法不触发任何重渲染。
  p.composerRef.current = { input, attachments }

  // 语音输入轻提示自动清除
  useEffect(() => {
    if (!voiceNotice) return
    const t = setTimeout(() => setVoiceNotice(''), 3200)
    return () => clearTimeout(t)
  }, [voiceNotice])

  // 外部重置信号（草稿恢复 / 新建清空 / 发送清空）：seq 递增时用 seed 内容重同步自身输入态
  useEffect(() => {
    if (p.seed.seq > 0) {
      setInput(p.seed.input)
      setAttachments(p.seed.attachments)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.seed.seq])

  // 模型下拉：点击窗口其他位置时关闭
  useEffect(() => {
    if (!modelMenuOpen) return
    function onDown(e: MouseEvent): void {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setModelMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [modelMenuOpen])

  // 安全模式下拉：点击窗口其他位置时关闭
  useEffect(() => {
    if (!approvalMenuOpen) return
    function onDown(e: MouseEvent): void {
      if (approvalMenuRef.current && !approvalMenuRef.current.contains(e.target as Node)) setApprovalMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [approvalMenuOpen])

  /** 生成附件唯一 id */
  const genId = useCallback((): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, [])

  /** 图片附件自动上传云存储：拿到 https 链接后回填到对应附件 */
  const uploadImageAttachment = useCallback((id: string, dataUrl: string, mime: string): void => {
    void (async () => {
      const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
      try {
        const url = (await window.shanhai?.uploadImage(base64, mime)) ?? null
        setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, uploadStatus: url ? 'done' : 'error', url: url ?? undefined } : x)))
      } catch {
        setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, uploadStatus: 'error' } : x)))
      }
    })()
  }, [])

  /** 重新上传某张上传失败的图片附件 */
  const retryImageUpload = useCallback(
    (id: string): void => {
      const a = attachments.find((x) => x.id === id)
      if (!a || a.type !== 'image') return
      setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, uploadStatus: 'uploading', url: undefined } : x)))
      uploadImageAttachment(id, a.dataUrl, a.mime)
    },
    [attachments, uploadImageAttachment],
  )

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
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
    },
    [uploadImageAttachment, genId],
  )

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
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
    },
    [uploadImageAttachment, genId],
  )

  /** 语音输入：点击开始录音，再次点击停止；识别结果填入输入框 */
  const toggleRecording = useCallback(async (): Promise<void> => {
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
        if (r > Math.max(noiseFloor * 3, 0.012)) {
          lastVoiceFrame = totalFrames
          consecutiveSilenceFrames = 0
        } else {
          noiseFloor = totalFrames < NOISE_ESTIMATE_FRAMES
            ? (noiseFloor * totalFrames + r) / (totalFrames + 1)
            : noiseFloor * 0.95 + r * 0.05
          consecutiveSilenceFrames++
          if (lastVoiceFrame >= 0 && consecutiveSilenceFrames >= TRAILING_SILENCE_FRAMES) {
            finishRecording('auto')
            return
          }
        }
        totalFrames++
      }
      source.connect(processor)
      const silenceGain = audioCtx.createGain()
      silenceGain.gain.value = 0
      processor.connect(silenceGain)
      silenceGain.connect(audioCtx.destination)

      mediaRecorderRef.current = { stop: () => finishRecording('manual') }
      setRecording(true)
    } catch (err) {
      console.error('麦克风不可用或录音失败', err)
      setRecording(false)
    }
  }, [recording])

  return (
    <Composer
      isEmpty={p.isEmpty}
      attachments={attachments}
      setAttachments={setAttachments}
      retryImageUpload={retryImageUpload}
      setPreviewImage={p.setPreviewImage}
      fileRef={fileRef}
      handleFileSelect={handleFileSelect}
      queueCount={p.queueCount}
      voiceNotice={voiceNotice}
      input={input}
      setInput={setInput}
      isComposingRef={isComposingRef}
      handlePaste={handlePaste}
      modelMenuRef={modelMenuRef}
      modelMenuOpen={modelMenuOpen}
      setModelMenuOpen={setModelMenuOpen}
      models={p.models}
      selectedModel={p.selectedModel}
      loggedIn={p.loggedIn}
      selectModel={p.selectModel}
      workDir={p.workDir}
      workDirName={p.workDirName}
      pickWorkdir={p.pickWorkdir}
      approvalMenuRef={approvalMenuRef}
      approvalMenuOpen={approvalMenuOpen}
      setApprovalMenuOpen={setApprovalMenuOpen}
      approvalPolicy={p.approvalPolicy}
      switchApprovalPolicy={p.switchApprovalPolicy}
      recording={recording}
      toggleRecording={toggleRecording}
      busy={p.busy}
      send={p.send}
      stopSend={p.stopSend}
    />
  )
})

export const ChatComposer = ChatComposerInner