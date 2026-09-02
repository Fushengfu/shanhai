import * as React from 'react'
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Composer } from '../components/Composer'
import type { AttachmentItem, GatewayModel } from '../types'
import { readFileAsDataUrl } from '../components/ui'

/** 通过 ref 暴露给父组件（SupervisorApp）的输入区读取接口：send 时从 ref 取当前输入，使键入不再冒泡到顶层 */
export interface SupervisorComposerHandle {
  getInput(): string
  getAttachments(): AttachmentItem[]
  clearInput(): void
}

export interface SupervisorComposerProps {
  busy: boolean
  models: GatewayModel[]
  /** 全局默认模型 id，作为 supervisorModel 为空时的兜底 */
  defaultSelectedModel: string
  loggedIn: boolean
  setPreviewImage: (v: string | null) => void
  onSend: () => Promise<void>
  onStop: () => void
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

/**
 * 会话管家输入区（自包含）：内部持有 input / attachments / recording / 菜单开关 / 管家模型与安全模式等输入态，
 * 通过 React.memo + 自持 state 让「每次键入」只重渲染本子树，不再触发 SupervisorApp（含 {nodes} 历史消息树）整窗重渲染。
 */
const SupervisorComposerInner = forwardRef<SupervisorComposerHandle, SupervisorComposerProps>(
  function SupervisorComposerInner(p, ref) {
    const [input, setInput] = useState('')
    const [attachments, setAttachments] = useState<AttachmentItem[]>([])
    const [recording, setRecording] = useState(false)
    const [voiceNotice, setVoiceNotice] = useState('')
    const [modelMenuOpen, setModelMenuOpen] = useState(false)
    const [approvalMenuOpen, setApprovalMenuOpen] = useState(false)
    const [supervisorModel, setSupervisorModel] = useState('')
    const [supervisorApproval, setSupervisorApproval] = useState<'ask' | 'workdir' | 'never'>('ask')

    const fileRef = useRef<HTMLInputElement>(null)
    const modelMenuRef = useRef<HTMLDivElement>(null)
    const approvalMenuRef = useRef<HTMLDivElement>(null)
    const isComposingRef = useRef(false)
    const mediaRecorderRef = useRef<{ stop: () => void } | null>(null)

    useImperativeHandle(
      ref,
      () => ({
        getInput: () => input,
        getAttachments: () => attachments,
        clearInput: () => {
          setInput('')
          setAttachments([])
        },
      }),
      [input, attachments],
    )

    // 启动时加载管家模型 / 安全模式（会话级，独立于其他会话与全局）
    useEffect(() => {
      const api = window.shanhai
      if (!api) return
      void api.supervisorGetModel().then((m) => setSupervisorModel(m)).catch(() => undefined)
      void api.supervisorGetApproval().then((p) => setSupervisorApproval(p)).catch(() => undefined)
    }, [])

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
    const retryImageUpload = useCallback((id: string): void => {
      const a = attachments.find((x) => x.id === id)
      if (!a || a.type !== 'image') return
      setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, uploadStatus: 'uploading', url: undefined } : x)))
      uploadImageAttachment(id, a.dataUrl, a.mime)
    }, [attachments, uploadImageAttachment])

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
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
    }, [uploadImageAttachment, genId])

    const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
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
    }, [uploadImageAttachment, genId])

    /** 语音输入：点击开始录音，再次点击停止；录音结束交后端 AI 识别，结果填入输入框（与聊天窗口一致） */
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
    }, [recording])

    /** 切换管家自己的模型：只影响 supervisor 会话，不碰全局默认模型、不碰其他会话 */
    const selectModel = useCallback((id: string): void => {
      setSupervisorModel(id)
      setModelMenuOpen(false)
      void window.shanhai?.supervisorSetModel(id)
    }, [])

    /** 切换管家自己的安全模式：只影响 supervisor 会话，不碰全局、不碰其他会话 */
    const switchApprovalPolicy = useCallback((policy: 'ask' | 'workdir' | 'never'): void => {
      setSupervisorApproval(policy)
      setApprovalMenuOpen(false)
      void window.shanhai?.supervisorSetApproval(policy)
    }, [])

    return (
      <Composer
        isEmpty={false}
        attachments={attachments}
        setAttachments={setAttachments}
        retryImageUpload={retryImageUpload}
        setPreviewImage={p.setPreviewImage}
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
        models={p.models}
        selectedModel={supervisorModel || p.defaultSelectedModel}
        loggedIn={p.loggedIn}
        selectModel={selectModel}
        showWorkdir={false}
        approvalMenuRef={approvalMenuRef}
        approvalMenuOpen={approvalMenuOpen}
        setApprovalMenuOpen={setApprovalMenuOpen}
        approvalPolicy={supervisorApproval}
        switchApprovalPolicy={switchApprovalPolicy}
        recording={recording}
        toggleRecording={toggleRecording}
        busy={p.busy}
        send={p.onSend}
        stopSend={p.onStop}
      />
    )
  },
)

export const SupervisorComposer = memo(SupervisorComposerInner)