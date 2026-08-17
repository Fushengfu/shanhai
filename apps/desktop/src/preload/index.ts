import { contextBridge, ipcRenderer } from 'electron'

export interface ToolTrace {
  kind: 'tool-call' | 'tool-result'
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
  toolName: string
  args: Record<string, unknown>
  riskLevel: string
}

export interface ShanhaiBridge {
  // 认证
  status(): Promise<{ loggedIn: boolean; username: string | null }>
  login(username: string, password: string): Promise<{ username: string }>
  logout(): Promise<void>
  listModels(): Promise<Array<{ id: string; name: string; tier: string; apiKey: string; baseUrl: string }>>
  // 会话
  listSessions(): Promise<Array<{ id: string; title: string }>>
  switchSession(id: string): Promise<void>
  // 审批
  onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void
  respondApproval(outcome: 'allowed-once' | 'rejected'): Promise<void>
  // 工具过程
  onToolTrace(cb: (trace: ToolTrace) => void): () => void
  // 聊天
  run(message: string): Promise<string>
  onDelta(cb: (text: string) => void): () => void
}

const bridge: ShanhaiBridge = {
  status: () => ipcRenderer.invoke('auth:status'),
  login: (u, p) => ipcRenderer.invoke('auth:login', u, p),
  logout: () => ipcRenderer.invoke('auth:logout'),
  listModels: () => ipcRenderer.invoke('auth:listModels'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  switchSession: (id) => ipcRenderer.invoke('session:switch', id),
  respondApproval: (outcome) => ipcRenderer.invoke('approval:respond', outcome),
  run: (message) => ipcRenderer.invoke('chat:run', message),
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
    const listener = (_e: unknown, text: string) => cb(text)
    ipcRenderer.on('chat:delta', listener)
    return () => ipcRenderer.removeListener('chat:delta', listener)
  },
}

contextBridge.exposeInMainWorld('shanhai', bridge)
