import type { ComponentType } from 'react'

/** Web Speech API 最小类型（renderer 端语音识别，Electron 内基于系统语音服务） */
export interface SpeechRecognitionAlternativeLike {
  transcript: string
}
export interface SpeechRecognitionResultLike {
  isFinal: boolean
  0?: SpeechRecognitionAlternativeLike
}
export interface SpeechRecognitionResultListLike {
  resultIndex: number
  results: Array<SpeechRecognitionResultLike | undefined>
  length: number
}
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionResultListLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: unknown) => void) | null
  start(): void
  stop(): void
}

export interface ToolTrace {
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

export interface ApprovalRequest {
  id: string
  sessionId?: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: string
}

export interface GatewayModel {
  id: string
  name: string
  tier: string
  apiKey: string
  baseUrl: string
  model?: string
  custom?: boolean
}

export interface ContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'input_video'
  text?: string
  image_url?: { url: string }
  input_audio?: { data: string; format: string }
  input_video?: { data: string; format: string }
}

export interface TokenSnapshot {
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

export type HistoryItem =
  | { kind: 'user'; content?: string; attachments?: unknown[] }
  | { kind: 'assistant'; content?: string; reasoningContent?: string }
  | { kind: 'tool'; trace?: ToolTrace }

/** 自修改（K5）browser 半投递的 round-trip 审批请求 */
export interface ClientRunRequest {
  requestId: string
  sessionId: string
  pkgId: string
  name: string
  purpose: string
}

/** 多专家编排轨迹（Triage 拆解 → 专家执行过程） */
export interface ExpertTrace {
  sessionId?: string
  stepId: string
  expertId: string
  expertName: string
  title: string
  status: 'started' | 'completed' | 'failed'
  result?: string
  error?: string
}

/** 长期记忆条目 */
export interface MemoryEntry {
  id: number
  scope: string
  key: string
  value: unknown
  source: string
  confidence: number
  timestamp: number
}

/** 动态注册到 UI 插槽的组件（browser 半 slots.register 的产物） */
export interface ClientComponentReg {
  slot: string
  id: string
  pkgId: string
  Component: ComponentType
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
      transcribeAudio(audioBase64: string): Promise<string>
      getTokenStats(): Promise<TokenSnapshot>
      onTokenStats(cb: (sessionId: string, stats: TokenSnapshot) => void): () => void
      selfmodInspect(sessionId?: string): Promise<unknown>
      onClientRunRequest(cb: (req: ClientRunRequest) => void): () => void
      respondClientRun(requestId: string, approved: boolean): Promise<void>
      onClientCode(cb: (payload: { pkgId: string; name: string; code: string }) => void): () => void
      onClientRemove(cb: (pkgId: string) => void): () => void
      onExpertTrace(cb: (trace: ExpertTrace) => void): () => void
      listMemory(): Promise<MemoryEntry[]>
      removeMemory(id: number): Promise<void>
    }
  }
}

export type ChatItem =
  | { kind: 'user'; content: string; images?: string[] }
  | { kind: 'assistant'; content: string; reasoningContent?: string }
  | { kind: 'tool'; trace: ToolTrace }

/** 每个会话独立的 UI 状态（支持并行会话：切换会话后，后台会话继续跑，互不串扰） */
export interface SessionUIState {
  items: ChatItem[]
  streaming: string
  streamingReasoning: string
  busy: boolean
}

export const EMPTY_SESSION: SessionUIState = { items: [], streaming: '', streamingReasoning: '', busy: false }

/** 附件（输入框里已选择的图片/音频/视频/普通文件） */
export interface AttachmentItem {
  type: 'image' | 'audio' | 'video' | 'file'
  name: string
  dataUrl: string
  mime: string
  size: number
}
