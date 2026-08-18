import { contextBridge, ipcRenderer } from 'electron'

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

/** 多模态内容片段（与 llm 包 ContentPart 对应） */
export interface ContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'input_video'
  text?: string
  image_url?: { url: string }
  input_audio?: { data: string; format: string }
  input_video?: { data: string; format: string }
}

export interface ShanhaiBridge {
  // 认证
  status(): Promise<{ loggedIn: boolean; username: string | null }>
  login(username: string, password: string): Promise<{ username: string; nickname?: string }>
  logout(): Promise<void>
  listModels(): Promise<Array<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; custom?: boolean }>>
  addCustomModel(model: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string; custom?: boolean }>
  removeCustomModel(id: string): Promise<void>
  // 会话
  listSessions(): Promise<Array<{ id: string; title: string }>>
  createSession(title?: string): Promise<string>
  switchSession(id: string): Promise<void>
  getSessionHistory(id?: string): Promise<Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; trace?: ToolTrace; attachments?: unknown[] }>>
  // 审批
  onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void
  respondApproval(outcome: 'allowed-once' | 'rejected', requestId: string): Promise<void>
  // 工具过程
  onToolTrace(cb: (trace: ToolTrace) => void): () => void
  // 聊天
  run(message: string, attachments?: ContentPart[]): Promise<string>
  onDelta(cb: (sessionId: string, text: string) => void): () => void
  // 模型 / 中断 / 语音 / 电脑
  switchModel(id: string): Promise<void>
  getCurrentModelId(): Promise<string>
  stop(): Promise<void>
  speak(text: string): Promise<void>
  screenshot(): Promise<string>
}

const bridge: ShanhaiBridge = {
  status: () => ipcRenderer.invoke('auth:status'),
  login: (u, p) => ipcRenderer.invoke('auth:login', u, p),
  logout: () => ipcRenderer.invoke('auth:logout'),
  listModels: () => ipcRenderer.invoke('auth:listModels'),
  addCustomModel: (model) => ipcRenderer.invoke('model:addCustom', model),
  removeCustomModel: (id) => ipcRenderer.invoke('model:removeCustom', id),
  listSessions: () => ipcRenderer.invoke('session:list'),
  createSession: (title) => ipcRenderer.invoke('session:create', title),
  switchSession: (id) => ipcRenderer.invoke('session:switch', id),
  getSessionHistory: (id) => ipcRenderer.invoke('session:history', id),
  respondApproval: (outcome, requestId) => ipcRenderer.invoke('approval:respond', outcome, requestId),
  run: (message, attachments) => ipcRenderer.invoke('chat:run', message, attachments),
  switchModel: (id) => ipcRenderer.invoke('model:switch', id),
  getCurrentModelId: () => ipcRenderer.invoke('model:current'),
  stop: () => ipcRenderer.invoke('chat:stop'),
  speak: (text) => ipcRenderer.invoke('voice:speak', text),
  screenshot: () => ipcRenderer.invoke('computer:shot'),
  onApprovalRequest: (cb) => {
    const listener = (_e: unknown, req: ApprovalRequest) => cb(req)
    ipcRenderer.on('approval:request', listener)
    return () => ipcRenderer.removeListener('approval:request', listener)
  },
  onToolTrace: (cb) => {
    const listener = (_e: unknown, trace: ToolTrace) => cb(trace)
    ipcRenderer.on('tool:trace', listener)
    return () => ipcRenderer.removeListener('tool:trace', listener)
  },
  onDelta: (cb) => {
    const listener = (_e: unknown, sessionId: string, text: string) => cb(sessionId, text)
    ipcRenderer.on('chat:delta', listener)
    return () => ipcRenderer.removeListener('chat:delta', listener)
  },
}

contextBridge.exposeInMainWorld('shanhai', bridge)
