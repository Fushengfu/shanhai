import { Kernel, FileSnapshotStore, type DynamicPackage } from '@shanhai/kernel'
import { SelfModifyRuntime } from './selfmod'
import { Session, effectiveApprovalPolicy, type SessionEvent } from '@shanhai/session'
import { ApprovalService } from '@shanhai/approval'
import { AgentLoop, ModelTriage, Orchestrator, type RoleDefinition, type StepTrace } from '@shanhai/agent'
import type { Model, ContentPart, TokenUsage } from '@shanhai/llm'
import { createMockModel, DeepSeekProvider } from '@shanhai/llm'
import { createAtomicTools, type ToolContract } from '@shanhai/tools'
import { MemoryStore } from '@shanhai/memory'
import { FileCredentialStore, AuthService } from '@shanhai/auth'
import type { GatewayModel, ModelTier } from '@shanhai/auth'
import type { VoiceService } from '@shanhai/voice'
import { createComputerUseTools, type ComputerUseService, type OcrWord } from '@shanhai/computer-use'
import { createBrowserUseTools, createMockBrowserUseService, type BrowserUseService } from '@shanhai/browser-use'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, isAbsolute } from 'node:path'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'

const execAsync = promisify(execCallback)

/** 并行会话的工具调用上下文：让全局工具包装层知道「当前工具属于哪个会话」 */
const sessionContext = new AsyncLocalStorage<string>()

/** 工具调用过程事件（推给 UI 展示「思考 → 工具 → 结果」） */
export interface ToolTrace {
  kind: 'tool-call' | 'tool-result'
  /** 所属会话 id（并行会话时 UI 据此路由） */
  sessionId: string
  callId: string
  name: string
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  approvalRequired?: boolean
  approved?: boolean
}

export type ApprovalOutcome = 'allowed-once' | 'rejected'

/** token 用量快照（UI 底部状态栏展示：累计 / 本轮 / 上下文占比） */
export interface TokenSnapshot {
  /** 累计（本次启动以来的所有模型调用） */
  totalPrompt: number
  totalCompletion: number
  total: number
  /** 本轮任务（当前 run 期间） */
  turnPrompt: number
  turnCompletion: number
  turn: number
  /** 当前模型上下文窗口长度（无则 0） */
  contextLength: number
  /** 最近一次请求的 prompt tokens（即已占用的上下文） */
  lastPrompt: number
  /** 上下文窗口占比 0~1（lastPrompt / contextLength，contextLength 为 0 时返回 0） */
  contextUsageRatio: number
  /** 本轮缓存命中 token（prompt_tokens_details.cached_tokens） */
  turnCachedPromptTokens: number
  /** 累计缓存命中 token */
  totalCachedPromptTokens: number
  /** 本轮缓存命中率 0~1（缓存命中 token / 本轮输入 token，无输入则 0） */
  cacheHitRatio: number
  /** 累计执行轮次（当前会话内，一次完整的「用户消息 → 最终回复」任务循环算一轮） */
  turnCount: number
}

export interface Runtime {
  kernel: Kernel
  session: Session
  tools: ToolContract[]
  model: Model
  memory: MemoryStore
  credentials: FileCredentialStore
  voice: VoiceService
  computerUse: ComputerUseService
  browserUse: BrowserUseService

  /** 登录状态 */
  loggedIn: boolean
  username: string | null
  /** 账号密码登录（SHA-256），成功后拉取会员模型并切换为真实网关模型 */
  login(username: string, password: string): Promise<{ username: string; nickname?: string }>
  logout(): Promise<void>
  /** 网关模型列表（系统内置 + 用户自定义） */
  listModels(): Promise<GatewayModel[]>
  /** 新增用户自定义模型（OpenAI 兼容端点 + Key），返回落库后的模型 */
  addCustomModel(model: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<GatewayModel>
  /** 编辑用户自定义模型（按 id 更新，保留 id） */
  updateCustomModel(id: string, model: { name: string; baseUrl: string; apiKey: string; model: string }): Promise<GatewayModel>
  /** 删除用户自定义模型 */
  removeCustomModel(id: string): Promise<void>
  /** 当前选中模型（tier 路由） */
  selectedTier: ModelTier

  /** 会话列表（内存多会话，含每会话工作目录） */
  listSessions(): Array<{ id: string; title: string; workDir: string }>
  switchSession(id: string): void
  /** 重命名会话标题 */
  renameSession(id: string, title: string): void
  /** 删除会话（当前会话被删则切到剩余第一个） */
  deleteSession(id: string): Promise<void>
  /** 获取指定会话工作目录（不传 id 用当前会话） */
  getSessionWorkdir(id?: string): string
  /** 修改指定会话工作目录 */
  setSessionWorkdir(id: string, workdir: string): void
  /** 把用户上传的普通文件（非媒体）保存到当前会话工作目录，返回绝对路径（供 read_file 等工具读取） */
  saveUploadedFile(fileName: string, dataBase64: string): Promise<string>
  /** 列出指定会话（缺省当前会话）打开的浏览器窗口（会话级隔离） */
  listBrowserWindows(sessionId?: string): Promise<Array<{ appId: string; url: string; title: string }>>
  /** 显示并聚焦指定浏览器窗口（用户点击标签恢复窗口） */
  showBrowserWindow(appId: string): Promise<void>
  /** 关闭指定浏览器窗口（appId 为 list 返回的完整标识） */
  closeBrowserWindow(appId: string): Promise<void>
  /** 获取指定会话的历史消息（UI 切换会话时加载；不传 id 用当前会话） */
  getSessionHistory(id?: string): Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[] }>
  /** 获取指定会话的完整执行痕迹（请求大模型的消息角色 + 工具调用 + 元数据，供轨迹面板查看） */
  getSessionTrace(id?: string): Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    reasoningContent?: string
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
    toolCallId?: string
    turn: number
    timestamp: number
  }>
  /** 新建会话（可指定工作目录），返回会话 id */
  createSession(title?: string, workdir?: string): string
  /** 当前会话的历史消息（用于 UI 切换会话时回放） */
  getHistory(): Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }>

  /** 工具调用过程回调（UI 展示，trace 带 sessionId） */
  onToolTrace(cb: (trace: ToolTrace) => void): () => void
  /** 审批请求回调（UI 弹卡片，req 带 sessionId） */
  onApprovalRequest(cb: (req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void): () => void
  /** UI 应答审批（requestId 定位具体审批请求，支持并行会话） */
  respondApproval(outcome: ApprovalOutcome, requestId: string): void

  /** 流式增量回调（sessionId 标识来源会话） */
  onDelta(cb: (sessionId: string, text: string) => void): () => void
  /** 流式思考增量回调（推理模型 reasoning_content，UI 实时渲染「思考过程」） */
  onReasoning(cb: (sessionId: string, text: string) => void): () => void

  /** 当前 token 用量快照（累计 / 本轮 / 上下文占比 / 缓存命中，会话级） */
  getTokenStats(): TokenSnapshot
  /** token 用量变化回调（模型每次返回 usage 时推送，带 sessionId 标识所属会话） */
  onTokenStats(cb: (sessionId: string, stats: TokenSnapshot) => void): () => void

  /** 切换模型（动态更新 provider，后续对话用新模型，并持久化到本地） */
  switchModel(modelId: string): void
  /** 当前选中的模型 id（从本地缓存恢复，重启后仍记住） */
  getCurrentModelId(): string
  /** 中断当前会话的进行中任务（并行会话互不影响） */
  stop(): void

  /** 跑一次任务（端到端 ReAct，支持多模态附件；绑定当前会话，切换会话后后台继续跑） */
  run(message: string, opts?: { maxSteps?: number; attachments?: ContentPart[] }): Promise<string>

  /**
   * 重新发送某条用户消息（参考 DSH / taco 的 resendFromExisting）：
   * 截断到该用户消息之前，重新生成回复。newContent 传了则用新内容（编辑后重发）。
   * userMessageIndex 为该会话内用户消息的序号（0 起）。
   */
  resend(sessionId: string, userMessageIndex: number, newContent?: string): Promise<string>
  /** 继续执行：把最后一条用户消息重新生成（断点恢复 / 中断后续跑） */
  resume(sessionId: string): Promise<string>
  /** 会话是否存在「未完成的消息」（最后一条用户消息之后没有 assistant/message 或 turn/end） */
  hasIncompleteTurn(sessionId: string): boolean
  /** 当前审批策略（安全模式） */
  getApprovalPolicy(): 'ask' | 'never'
  /** 切换审批策略（安全模式），并持久化到本地 */
  setApprovalPolicy(policy: 'ask' | 'never'): void

  /** 自修改（K5）：查看当前会话的动态插件包 / 服务 / 工具 / UI 插槽表面 */
  selfmodInspect(sessionId?: string): unknown
  /** 自修改：browser 半投递前的 round-trip 审批请求回调（UI 弹卡片） */
  onClientRunRequest(cb: (req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }) => void): () => void
  /** UI 应答 browser 半投递审批（approved=true 投递，false 拒绝） */
  respondClientRun(requestId: string, approved: boolean): void
  /** browser 半代码投递回调（UI 收到后 slots 注册渲染） */
  onClientCode(cb: (payload: { pkgId: string; name: string; code: string }) => void): () => void
  /** browser 半卸载回调（UI 移除组件） */
  onClientRemove(cb: (pkgId: string) => void): () => void
  /** 多专家编排轨迹回调（UI 展示 Triage 拆解 → 专家执行过程） */
  onExpertTrace(cb: (trace: StepTrace) => void): () => void
  /** 列出长期记忆（跨会话，配置型 + 经验型） */
  listMemory(): Array<{ id: number; scope: string; key: string; value: unknown; source: string; confidence: number; timestamp: number }>
  /** 删除一条长期记忆（按 id） */
  removeMemory(id: number): void
}

/** 从本地凭证装配真实网关模型；无凭证则 mock 兜底 */
async function createGatewayModel(onUsage?: (usage: TokenUsage) => void): Promise<Model> {
  try {
    const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as {
      gateway?: { baseUrl?: string; apiKey?: string; selectedModelId?: string }
    }
    const g = cfg.gateway
    if (g?.baseUrl && g?.apiKey && g?.selectedModelId) {
      return new DeepSeekProvider({ apiKey: g.apiKey, baseUrl: g.baseUrl, model: g.selectedModelId, onUsage })
    }
  } catch {
    // 无凭证，走 mock
  }
  return createMockModel([{ text: '你好，我是山海智能体。' }])
}

function inferTier(id: string): ModelTier {
  if (/flash|step-3/i.test(id)) return 'value'
  return 'flagship'
}

/** 视觉模型匹配提示词（这些厂商的模型通常支持多模态视觉） */
const VISION_HINTS = ['qwen', 'kimi', 'mimo', 'minimax', 'longcat', 'glm', 'vision', 'vl', 'omni', 'step']

function isVisionModel(id: string): boolean {
  const lower = id.toLowerCase()
  return VISION_HINTS.some((h) => lower.includes(h))
}

/** 判断模型是否支持视觉：优先用接口返回的 supportsVision 字段，缺省时回退 id 猜测 */
function modelSupportsVision(m: GatewayModel | undefined): boolean {
  if (!m) return false
  if (m.supportsVision !== undefined) return m.supportsVision
  return isVisionModel(m.id)
}

/** 用 apiKey 拉取网关完整模型列表（/api/v1/models，13 个模型，各自 baseUrl） */
async function fetchGatewayModels(apiKey: string, baseUrl: string): Promise<GatewayModel[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      code?: number
      data?: { data?: Array<{ id: string; displayName?: string; baseUrl?: string; model?: string }> }
    }
    const list = data.data?.data ?? []
    return list.map((m) => ({
      id: m.id,
      name: m.displayName ?? m.id,
      tier: inferTier(m.id),
      apiKey,
      baseUrl: m.baseUrl ?? baseUrl,
    }))
  } catch {
    return []
  }
}

/** 持久化选中模型到 config.json（下次打开不再重复选择） */
async function persistSelectedModel(modelId: string): Promise<void> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    const raw = await fs.readFile(path, 'utf8')
    const cfg = JSON.parse(raw) as { gateway?: { selectedModelId?: string } }
    if (cfg.gateway) cfg.gateway.selectedModelId = modelId
    await fs.writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch {
    // 忽略持久化失败
  }
}

/** 持久化用户自定义模型列表（独立于系统内置模型，登录态无关） */
async function persistCustomModels(models: GatewayModel[]): Promise<void> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      // 新文件
    }
    const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
    g.customModels = models
    cfg.gateway = g
    await fs.writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch {
    // 忽略持久化失败
  }
}

/** 登录成功后合并保存凭证（更新 memberToken + account + 网关模型凭证，密码不落盘） */
async function persistLoginToken(
  token: string,
  username: string,
  member: { nickname?: string; avatar?: string } | undefined,
  gateway: { apiKey: string; baseUrl: string; selectedModelId: string; models: GatewayModel[] },
): Promise<void> {
  try {
    const path = join(homedir(), '.shanhai', 'config.json')
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      // 新文件
    }
    const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
    g.memberToken = token
    g.account = { username, ...(member ?? {}) }
    g.apiKey = gateway.apiKey
    g.baseUrl = gateway.baseUrl
    g.selectedModelId = gateway.selectedModelId
    g.models = gateway.models
    cfg.gateway = g
    await fs.writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch {
    // 忽略持久化失败
  }
}

/** 真实语音：TTS 走 macOS say（真实发声），STT 需系统麦克风权限（暂返回空） */
function createSystemVoiceService(): VoiceService {
  return {
    transcribe: async () => '',
    synthesize: async (text) => {
      await execAsync(`say ${JSON.stringify(text)}`).catch(() => undefined)
      return new TextEncoder().encode(text).buffer as ArrayBuffer
    },
  }
}

/** macOS Vision OCR 脚本：识别图片文字 + 精确像素坐标（左上角原点）。运行时写入临时文件用 swift 执行。 */
const OCR_SWIFT = `
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count > 1 else { print("[]"); exit(0) }
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else { print("[]"); exit(0) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch { print("[]"); exit(0) }

let w = CGFloat(cg.width)
let h = CGFloat(cg.height)
let words: [[String: Any]] = (request.results ?? []).compactMap { obs in
    guard let cand = obs.topCandidates(1).first else { return nil }
    let box = obs.boundingBox
    // Vision 原点在左下角，转为左上角原点 + 像素坐标
    let x0 = box.minX * w
    let y0 = (1 - box.maxY) * h
    let x1 = box.maxX * w
    let y1 = (1 - box.minY) * h
    return ["text": cand.string, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "confidence": cand.confidence]
}
do {
    let data = try JSONSerialization.data(withJSONObject: words)
    if let s = String(data: data, encoding: .utf8) { print(s) } else { print("[]") }
} catch { print("[]") }
`

/** 用 macOS Vision 对图片做 OCR，返回文字块 + 像素坐标；失败返回空数组（降级，不阻断） */
async function ocrImage(path: string): Promise<OcrWord[]> {
  const scriptPath = `/tmp/shanhai-ocr-${process.pid}.swift`
  try {
    await fs.writeFile(scriptPath, OCR_SWIFT, 'utf8')
    const { stdout } = await execAsync(`swift "${scriptPath}" "${path}"`, { timeout: 30000 })
    const parsed = JSON.parse(stdout.trim() || '[]') as OcrWord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined)
  }
}

/** 真实 computer-use：截图走 macOS screencapture，OCR 走 Vision，键鼠走 System Events */
function createSystemComputerUseService(): ComputerUseService {
  const screenshotToFile = async (): Promise<string> => {
    const tmp = `/tmp/shanhai-shot-${Date.now()}.png`
    await execAsync(`screencapture -x "${tmp}"`)
    return tmp
  }

  const clickAtOsascript = (x: number, y: number): string =>
    `osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`

  return {
    screenshot: async () => {
      const tmp = await screenshotToFile()
      try {
        const buf = await fs.readFile(tmp)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    },
    clickAt: async (x, y) => {
      await execAsync(clickAtOsascript(x, y)).catch(() => undefined)
    },
    doubleClickAt: async (x, y) => {
      await execAsync(`${clickAtOsascript(x, y)} -e 'delay 0.06' -e 'tell application "System Events" to click at {${x}, ${y}}'`).catch(() => undefined)
    },
    typeText: async (text) => {
      await execAsync(`osascript -e 'tell application "System Events" to keystroke ${JSON.stringify(text)}'`).catch(() => undefined)
    },
    pressKey: async (key) => {
      await execAsync(`osascript -e 'tell application "System Events" to key code ${keyCode(key)}'`).catch(() => undefined)
    },
    scroll: async (direction, amount) => {
      // 无 cliclick 时用方向键模拟滚动：down=下箭头(125)，up=上箭头(126)
      const code = direction === 'down' ? 125 : 126
      const times = Math.max(1, Math.min(Math.round(amount ?? 3), 20))
      for (let i = 0; i < times; i++) {
        await execAsync(`osascript -e 'tell application "System Events" to key code ${code}'`).catch(() => undefined)
      }
    },
    ocr: async (imageBase64) => {
      let tmp = ''
      try {
        if (imageBase64) {
          tmp = `/tmp/shanhai-ocr-${Date.now()}.png`
          await fs.writeFile(tmp, Buffer.from(imageBase64, 'base64'))
        } else {
          tmp = await screenshotToFile()
        }
        return await ocrImage(tmp)
      } finally {
        if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    },
  }
}

function keyCode(key: string): number {
  const map: Record<string, number> = { enter: 36, return: 36, space: 49, tab: 48, escape: 53, esc: 53, left: 123, right: 124, up: 126, down: 125 }
  return map[key.toLowerCase()] ?? 0
}

/**
 * host 装配：用内核装配底座服务 + 能力插件。
 * 暴露登录 / 会话 / 模型 / 工具过程 / 审批 等产品能力。
 */
export interface BootstrapOptions {
  /** 浏览器后端（桌面端注入 Electron 内置浏览器；CLI 模式缺省走 mock） */
  browserUse?: BrowserUseService
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<Runtime> {
  const kernel = new Kernel()

  // 网关凭证 + 模型列表（提前声明，供 image_analyze 工具闭包引用，登录部分赋值）
  let gatewayApiKey = ''
  let gatewayBaseUrl = ''
  let gatewayModels: GatewayModel[] = []
  /** 用户自定义模型（OpenAI 兼容端点 + 自有 Key，独立于系统内置模型） */
  let customModels: GatewayModel[] = []
  let currentModelId = ''

  /** 全部模型 = 系统内置 + 用户自定义（自定义标记 custom: true，UI 分组展示） */
  const allModels = (): GatewayModel[] => [...gatewayModels, ...customModels]

  // —— 会话（多会话，持久化到 ~/.shanhai/sessions/，每个会话独立工作目录）——
  interface SessionMeta {
    id: string
    title: string
    session: Session
    workDir: string
  }
  const sessionsDir = join(homedir(), '.shanhai', 'sessions')
  const sessions = new Map<string, SessionMeta>()
  let currentSessionId: string | null = null

  async function persistSession(meta: SessionMeta): Promise<void> {
    try {
      await fs.mkdir(sessionsDir, { recursive: true })
      // 只丢弃 assistant/delta（流式增量中间态，最终 assistant/message 已含完整内容，属去冗余而非丢数据）；
      // tool/result、附件 base64 等原始数据一律完整保留，不截断、不降级。
      const events = meta.session.list().filter((e) => e.type !== 'assistant/delta')
      const data = { id: meta.id, title: meta.title, workDir: meta.workDir, events }
      await fs.writeFile(join(sessionsDir, `${meta.id}.json`), JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch {
      // 忽略持久化失败
    }
  }

  const newSession = (title: string, workDir?: string): string => {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const meta: SessionMeta = { id, title, session: new Session(), workDir: workDir ?? join(homedir(), 'shanhai', 'workspace') }
    sessions.set(id, meta)
    currentSessionId = id
    void persistSession(meta)
    return id
  }

  function currentWorkDir(): string {
    const meta = currentSessionId ? sessions.get(currentSessionId) : undefined
    return meta?.workDir ?? join(homedir(), 'shanhai', 'workspace')
  }

  // 启动时加载历史会话（聊天记录持久化：重启后历史消息不丢）
  try {
    await fs.mkdir(sessionsDir, { recursive: true })
    const files = await fs.readdir(sessionsDir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(sessionsDir, f), 'utf8')
        const data = JSON.parse(raw) as { id: string; title: string; workDir?: string; events?: SessionEvent[] }
        const meta: SessionMeta = {
          id: data.id,
          title: data.title,
          session: new Session(),
          workDir: data.workDir ?? join(homedir(), 'shanhai', 'workspace'),
        }
        if (Array.isArray(data.events)) meta.session.restore(data.events)
        sessions.set(meta.id, meta)
      } catch {
        // 跳过损坏的会话文件
      }
    }
  } catch {
    // 忽略
  }
  if (sessions.size === 0) {
    newSession('新会话')
  } else {
    currentSessionId = sessions.values().next().value!.id
  }

  // —— 工具过程 + 审批桥（审批按 requestId 独立 resolve，支持并行会话）——
  const toolTraceCallbacks = new Set<(trace: ToolTrace) => void>()
  const approvalCallbacks = new Set<(req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }) => void>()
  const pendingApprovals = new Map<string, { resolve: (outcome: ApprovalOutcome) => void; sessionId?: string }>()

  const approval = new ApprovalService(async (req) => {
    approvalCallbacks.forEach((cb) => cb({ id: req.id, sessionId: req.sessionId, toolName: req.toolName, args: req.args, riskLevel: req.riskLevel }))
    return new Promise<ApprovalOutcome>((resolve) => {
      // 记录发起审批的会话 id：删除会话时按会话拒绝其待审批请求，避免 agent 永久卡在 await
      pendingApprovals.set(req.id, { resolve, sessionId: req.sessionId })
    })
  })

  // 审批策略（安全模式）改为「会话级」：每个会话独立的安全模式，通过 approval/policy 事件持久化到会话 JSON。
  // 这里不再维护全局 policy 变量；会话级 policy 由 ApprovalService 从会话事件日志回放（effectiveApprovalPolicy）。
  /** 读取指定会话（缺省当前会话）的审批策略：从事件日志回放，缺省 'ask' */
  const sessionApprovalPolicy = (sid?: string): 'ask' | 'never' => {
    const meta = sessions.get(sid ?? currentSessionId ?? '')
    if (!meta) return 'ask'
    return effectiveApprovalPolicy(meta.session.list()) ?? 'ask'
  }

  // —— 能力实例（提前创建，供工具使用）——
  const computerUse = createSystemComputerUseService()
  const browserUse: BrowserUseService = options.browserUse ?? createMockBrowserUseService()
  const voice = createSystemVoiceService()
  const memory = new MemoryStore()

  // 长期记忆持久化：启动时从 ~/.shanhai/memory.json 恢复（跨会话不丢），remember 后落盘
  const memoryFile = join(homedir(), '.shanhai', 'memory.json')
  try {
    const raw = await fs.readFile(memoryFile, 'utf8')
    const entries = JSON.parse(raw) as Array<{ scope: never; key: string; value: unknown; source?: never; confidence?: number }>
    for (const e of entries) {
      if (e && typeof e.key === 'string') memory.save(e.scope, e.key, e.value, { source: e.source, confidence: e.confidence })
    }
  } catch {
    // 无记忆文件或损坏，忽略
  }
  const persistMemory = async (): Promise<void> => {
    try {
      await fs.writeFile(memoryFile, JSON.stringify(memory.list(), null, 2), { mode: 0o600 })
    } catch {
      // 忽略持久化失败
    }
  }

  // —— computer-use 插件（操作电脑：截图 / OCR 定位 / 统一动作，形成「截图→定位→动作→验证」闭环）——
  const computerTools: ToolContract[] = createComputerUseTools(computerUse)

  // —— browser-use 插件（操作内置浏览器：导航 / 点击 / 输入 / 提取 / 截图 / 网络 / Cookie）——
  const browserTools: ToolContract[] = createBrowserUseTools(browserUse)

  // —— 图片识别：用视觉模型分析图片（当前模型不支持多模态时降级用）——
  const analyzeImageWithVision = async (imageUrl: string): Promise<string> => {
    let visionModels = gatewayModels.filter((m) => modelSupportsVision(m))
    // 启动时只缓存了当前模型，这里兜底拉取完整模型列表（含视觉模型）
    if (visionModels.length === 0 && gatewayApiKey && gatewayBaseUrl) {
      const list = await fetchGatewayModels(gatewayApiKey, gatewayBaseUrl)
      if (list.length > 0) {
        gatewayModels = list
        visionModels = list.filter((m) => modelSupportsVision(m))
      }
    }
    if (visionModels.length === 0 || !gatewayApiKey || !gatewayBaseUrl) return '（无可用视觉模型）'
    // 遍历视觉模型逐个尝试识别（部分模型 502/额度不足，降级到下一个，直到成功）
    const errors: string[] = []
    for (const vm of visionModels) {
      try {
        const provider = new DeepSeekProvider({ apiKey: gatewayApiKey, baseUrl: gatewayBaseUrl, model: vm.id, onUsage })
        const res = await provider.complete([
          {
            role: 'user',
            content: [
              { type: 'text', text: '请详细描述这张图片的内容，包括主体、文字、场景等。' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ])
        if (res.text && res.text.trim()) return res.text
        errors.push(`${vm.id}: 空结果`)
      } catch (err) {
        errors.push(`${vm.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return `（图片识别失败：${errors.join('；')}）`
  }

  // —— 图片识别工具（模型不支持多模态时，AI 调它用视觉模型分析图片）——
  const imageAnalyzeTool: ToolContract = {
    name: 'image_analyze',
    description: '分析图片内容并返回文字描述。当需要理解图片内容、但当前模型无法直接查看图片时使用。',
    inputSchema: {
      type: 'object',
      properties: { imageUrl: { type: 'string', description: '图片的 URL 或 data: URL' } },
      required: ['imageUrl'],
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const imageUrl = String(args.imageUrl ?? '')
      if (!imageUrl) return '（未提供图片）'
      return analyzeImageWithVision(imageUrl)
    },
  }

  // —— 工具（包装：落 trace，sessionId 从 AsyncLocalStorage 上下文取）——
  // 当前会话工作目录：让所有文件/命令工具围绕「会话工作目录」执行
  const getSessionCwd = (): string => {
    const sid = sessionContext.getStore() ?? currentSessionId ?? ''
    return sessions.get(sid)?.workDir ?? join(homedir(), 'shanhai', 'workspace')
  }
  /** 运行时环境快照：系统提示词里注入的「环境信息」全部来自这里，随每次请求自动采集（不写死） */
  interface RuntimeEnvironment {
    osName: string
    platform: string
    arch: string
    time: string
    shell: string
    home: string
    cwd: string
    lang: string
  }

  /**
   * 自动采集当前运行环境快照（时间 / 操作系统 / Shell / 主目录 / 工作目录 / 语言）。
   * 每次构建系统提示词时实时调用，保证环境信息始终是「初始化时自动注入」而非硬编码。
   */
  const collectEnvironment = (cwd: string): RuntimeEnvironment => {
    const osNames: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
    return {
      osName: osNames[process.platform] ?? process.platform,
      platform: process.platform,
      arch: process.arch,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
      home: homedir(),
      cwd,
      lang: 'zh-CN',
    }
  }

  /**
   * 系统提示词：告诉模型「当前环境」（时间 / 工作目录 / Shell / 系统类型 / 语言）+ 工具调用约束。
   * 环境信息由 collectEnvironment 自动注入，文件/命令操作都锚定到当前工作目录。
   */
  const buildSystemPrompt = (cwd: string, memoryContext?: string): string => {
    const env = collectEnvironment(cwd)
    return [
      '你是「山海」，一个运行在用户电脑上的桌面端 AI 智能体助手。你可以读取文件、编写代码、执行命令、列出目录来帮助用户完成任务。',
      '',
      '【当前环境】',
      `- 操作系统：${env.osName}（${env.platform}/${env.arch}）`,
      `- 当前时间：${env.time}`,
      `- Shell：${env.shell}`,
      `- 用户主目录：${env.home}`,
      `- 当前工作目录：${env.cwd}`,
      `- 语言：${env.lang}（优先用中文回复）`,
      '',
      '【工具使用规则】',
      '1. 所有文件操作（read_file / write_file / list_dir）和命令执行（run_command）都必须围绕「当前工作目录」进行。',
      '2. 文件路径既可以是绝对路径，也可以是相对于当前工作目录的相对路径；优先使用相对路径，把操作范围限制在工作目录内。',
      '3. 需要了解项目结构时，用 list_dir 以树形列出目录。',
      `4. 执行命令时注意当前是 ${env.osName} 系统，使用对应的命令语法（如 macOS/Linux 用 ls、cat，Windows 用 dir、type）。`,
      '5. 执行有风险的操作（写文件、运行命令）前会请求用户确认，请把要做的改动讲清楚再调用工具。',
      '6. 需要访问网页/网站、验证前端页面、提取网页数据时，用 browser_navigate 打开页面，配合 browser_get_content / browser_evaluate / browser_screenshot 观察，browser_click / browser_type 操作；截图前要有明确目的，排查问题先看 browser_get_console_logs。',
      memoryContext,
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** 构建长期记忆上下文：配置型全量注入 + 经验型按当前消息关键词召回（注入系统提示词） */
  const buildMemoryContext = (message: string): string | undefined => {
    const config = memory.list().filter((e) => e.scope !== 'task_experience' && e.scope !== 'session')
    const experience = memory.recall('task_experience', message).slice(0, 5)
    const all = [...config, ...experience]
    if (all.length === 0) return undefined
    const lines = all.map((e) => `- [${e.scope}] ${e.key}: ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}`)
    return `\n\n【长期记忆】\n${lines.join('\n')}`
  }
  // —— 写文件快照回滚（K4 安全：写前快照，可回滚恢复原文件）——
  const snapshotDir = join(homedir(), '.shanhai', 'snapshots')
  const snapshotStore = new FileSnapshotStore(snapshotDir)
  // 启动时清理历史快照（上次会话的快照随会话结束已无意义，避免目录无限积累）
  try {
    await fs.rm(snapshotDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
  /** 把相对路径解析到会话工作目录（rollback_file 工具用） */
  const resolveWorkPath = (p: string): string => (isAbsolute(p) ? p : join(getSessionCwd(), p))
  /** 写前快照回调：文件存在时备份，返回快照 id（write_file 覆盖前自动调用） */
  const snapshotFn = async (path: string): Promise<{ snapshotId: string } | undefined> => {
    try {
      return { snapshotId: await snapshotStore.snapshot(path) }
    } catch {
      return undefined
    }
  }
  /** 回滚工具：把文件恢复到 write_file 之前的快照（撤销写入） */
  const rollbackFileTool: ToolContract = {
    name: 'rollback_file',
    description:
      '把文件回滚到最近一次 write_file 之前的快照，恢复原内容（撤销写入）。' +
      'path 是目标文件路径（绝对路径或相对当前工作目录），snapshotId 是 write_file 返回结果里的 snapshotId。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        snapshotId: { type: 'string', description: 'write_file 返回的快照 id' },
      },
      required: ['path', 'snapshotId'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const path = resolveWorkPath(String(args.path))
      const id = String(args.snapshotId ?? '')
      if (!id) return { ok: false, error: '缺少 snapshotId' }
      await snapshotStore.rollback(path, id)
      await snapshotStore.discard(path, id)
      return { ok: true, path, rolledBack: true }
    },
  }

  // —— 长期记忆工具（K 记忆：显式保存 / 召回，跨会话持久于内存 + 注入系统提示词）——
  /** 保存一条长期记忆（scope 决定层：配置型全量注入 / 经验型相关性召回） */
  const rememberTool: ToolContract = {
    name: 'remember',
    description:
      '保存一条长期记忆（跨会话生效）。当用户表达偏好、项目背景、环境约定或任务经验时使用。' +
      'scope 可选：user_preference（用户偏好）、project_knowledge（项目知识）、environment（环境约定）、task_experience（任务经验）。' +
      'key 是记忆名，value 是记忆内容。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '记忆作用域' },
        key: { type: 'string', description: '记忆名' },
        value: { type: 'string', description: '记忆内容' },
      },
      required: ['scope', 'key', 'value'],
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const scope = String(args.scope ?? '') as never
      const key = String(args.key ?? '')
      const value = args.value
      if (!scope || !key) return { ok: false, error: 'scope 和 key 不能为空' }
      const entry = memory.save(scope, key, value)
      await persistMemory()
      return { ok: true, id: entry.id, scope, key }
    },
  }
  /** 召回长期记忆（按作用域 + 关键词） */
  const recallMemoryTool: ToolContract = {
    name: 'recall_memory',
    description: '召回长期记忆。按 scope 过滤、keyword 关键词匹配，返回最新的在前。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '记忆作用域（可选）' },
        keyword: { type: 'string', description: '关键词（可选）' },
      },
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const scope = args.scope ? (String(args.scope) as never) : undefined
      const keyword = args.keyword ? String(args.keyword) : undefined
      const list = scope ? memory.recall(scope, keyword) : memory.list().reverse()
      return { items: list }
    },
  }

  // —— 工具包装：落 trace + sessionId 注入。动态注册的自修改工具也走同一包装，保证 trace 一致 ——
  const tools: ToolContract[] = []
  const wrapTool = (t: ToolContract): ToolContract => ({
    ...t,
    execute: async (args) => {
      const sid = sessionContext.getStore() ?? currentSessionId ?? ''
      const callId = `${t.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      // 浏览器工具：注入会话 id 作为 appId（会话级隔离窗口），agent 传短名时拼接为「会话id:短名」。
      // 若 appId 已是完整标识（等于会话 id 或含会话前缀，如 browser_create 的返回值），直接复用，
      // 避免二次拼接导致窗口错位；否则按短名拼接会话前缀（默认短名 default）。
      let effectiveArgs = args
      if (t.name.startsWith('browser_')) {
        const raw = typeof args.appId === 'string' ? args.appId : ''
        const appId = raw && (raw === sid || raw.startsWith(`${sid}:`)) ? raw : `${sid}:${raw || 'default'}`
        effectiveArgs = { ...args, appId }
      }
      toolTraceCallbacks.forEach((cb) =>
        cb({ kind: 'tool-call', sessionId: sid, callId, name: t.name, args, approvalRequired: t.approvalRequired, approved: false }),
      )
      try {
        const result = await t.execute(effectiveArgs)
        // 结果 trace 带上 args：前端按工具类型渲染摘要（路径/命令）时需要它
        toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', sessionId: sid, callId, name: t.name, args, result }))
        return result
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        toolTraceCallbacks.forEach((cb) => cb({ kind: 'tool-result', sessionId: sid, callId, name: t.name, args, error }))
        throw err
      }
    },
  })

  // —— K5 自修改（cordis_* 工具 + vm 沙箱 + browser 半投递 + round-trip 审批）——
  const clientRunCallbacks = new Set<(req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }) => void>()
  const pendingClientRuns = new Map<string, { resolve: (approved: boolean) => void; sessionId?: string }>()
  const clientCodeCallbacks = new Set<(payload: { pkgId: string; name: string; code: string }) => void>()
  const clientRemoveCallbacks = new Set<(pkgId: string) => void>()

  const selfmod = new SelfModifyRuntime({
    listServices: () => ['session', 'approval', 'agent', 'memory', 'voice', 'computerUse', 'browserUse', 'model', 'credentials'],
    listTools: () => tools.map((t) => t.name),
    registerTool: (rawTool) => {
      const wrapped = wrapTool(rawTool)
      tools.push(wrapped)
      return () => {
        const idx = tools.indexOf(wrapped)
        if (idx >= 0) tools.splice(idx, 1)
      }
    },
    onEvent: (name, listener) => kernel.ctx.on(name, listener),
    requestClientRun: (pkg: DynamicPackage, sessionId: string) =>
      new Promise<boolean>((resolve) => {
        const requestId = `client-run-${Date.now()}-${Math.random().toString(36).slice(2)}`
        pendingClientRuns.set(requestId, { resolve, sessionId })
        clientRunCallbacks.forEach((cb) => cb({ requestId, sessionId, pkgId: pkg.id, name: pkg.name, purpose: pkg.purpose }))
      }),
    deliverClient: async (pkg: DynamicPackage) => {
      clientCodeCallbacks.forEach((cb) => cb({ pkgId: pkg.id, name: pkg.name, code: pkg.client ?? '' }))
    },
    removeClient: async (pkgId: string) => {
      clientRemoveCallbacks.forEach((cb) => cb(pkgId))
    },
  })

  const baseTools = [
    ...createAtomicTools(getSessionCwd, snapshotFn),
    imageAnalyzeTool,
    rollbackFileTool,
    rememberTool,
    recallMemoryTool,
    ...computerTools,
    ...browserTools,
    ...selfmod.createTools(() => sessionContext.getStore() ?? currentSessionId ?? ''),
  ]
  tools.push(...baseTools.map(wrapTool))

  // —— token 统计（累计 / 本轮 / 上下文占比，UI 底部状态栏展示；会话级隔离：每个会话独立累计，互不串扰）——
  interface TokenAccumulator {
    totalPrompt: number
    totalCompletion: number
    total: number
    turnPrompt: number
    turnCompletion: number
    turn: number
    contextLength: number
    lastPrompt: number
    turnCachedPromptTokens: number
    totalCachedPromptTokens: number
  }
  const tokenStats = new Map<string, TokenAccumulator>()
  const tokenCallbacks = new Set<(sessionId: string, stats: TokenSnapshot) => void>()

  /** 获取（或初始化）指定会话的 token 累计器 */
  const sessionStats = (sid: string): TokenAccumulator => {
    let s = tokenStats.get(sid)
    if (!s) {
      s = { totalPrompt: 0, totalCompletion: 0, total: 0, turnPrompt: 0, turnCompletion: 0, turn: 0, contextLength: 0, lastPrompt: 0, turnCachedPromptTokens: 0, totalCachedPromptTokens: 0 }
      tokenStats.set(sid, s)
    }
    return s
  }

  /** 指定会话累计完成的任务循环轮次（一次完整的「用户消息 → 最终回复」= 一轮，从事件日志统计，重启后自动恢复） */
  const countCompletedTurns = (sid?: string): number => {
    const meta = sessions.get(sid ?? currentSessionId ?? '')
    if (!meta) return 0
    return meta.session.list().filter((e) => e.type === 'turn/end').length
  }

  const snapshot = (sid?: string): TokenSnapshot => {
    const s = sessionStats(sid ?? currentSessionId ?? '')
    // contextLength 兜底当前模型（切模型/登录后写入当前会话，未写入时用模型属性兜底）
    const ctxLen = s.contextLength > 0 ? s.contextLength : allModels().find((m) => m.id === currentModelId)?.contextLength ?? 0
    return {
      totalPrompt: s.totalPrompt,
      totalCompletion: s.totalCompletion,
      total: s.total,
      turnPrompt: s.turnPrompt,
      turnCompletion: s.turnCompletion,
      turn: s.turn,
      contextLength: ctxLen,
      lastPrompt: s.lastPrompt,
      contextUsageRatio: ctxLen > 0 ? s.lastPrompt / ctxLen : 0,
      turnCachedPromptTokens: s.turnCachedPromptTokens,
      totalCachedPromptTokens: s.totalCachedPromptTokens,
      cacheHitRatio: s.turnPrompt > 0 ? s.turnCachedPromptTokens / s.turnPrompt : 0,
      turnCount: countCompletedTurns(sid),
    }
  }

  const emitTokenStats = (sid?: string): void => {
    const target = sid ?? currentSessionId ?? ''
    const s = snapshot(target)
    tokenCallbacks.forEach((cb) => cb(target, s))
  }

  /** 每次模型返回 usage 时累计（流式末尾 / 一次性 complete 均触发），按发起会话隔离 */
  const onUsage = (usage: TokenUsage): void => {
    const sid = sessionContext.getStore() ?? currentSessionId ?? ''
    const s = sessionStats(sid)
    const cached = usage.cachedPromptTokens ?? 0
    s.totalPrompt += usage.promptTokens
    s.totalCompletion += usage.completionTokens
    s.total += usage.totalTokens
    s.turnPrompt += usage.promptTokens
    s.turnCompletion += usage.completionTokens
    s.turn += usage.totalTokens
    s.lastPrompt = usage.promptTokens
    s.turnCachedPromptTokens += cached
    s.totalCachedPromptTokens += cached
    emitTokenStats(sid)
  }

  /** 刷新当前模型的上下文窗口长度（模型切换/登录后调用），写入当前会话 */
  const refreshContextLength = (): void => {
    const m = allModels().find((m) => m.id === currentModelId)
    const s = sessionStats(currentSessionId ?? '')
    s.contextLength = m?.contextLength ?? 0
    emitTokenStats()
  }

  // —— 模型 + agent ——
  let model = await createGatewayModel(onUsage)
  let sessionRef = sessions.get(currentSessionId!)!.session
  const deltaCallbacks = new Set<(sessionId: string, text: string) => void>()
  const reasoningCallbacks = new Set<(sessionId: string, text: string) => void>()
  refreshContextLength()

  // —— 登录 ——
  const credentials = new FileCredentialStore()
  const authService = new AuthService({ baseUrl: 'https://agent.bjctykj.com' })
  // 启动时恢复本地凭证（有 gateway apiKey 则视为已登录，模型调用走 apiKey）
  let loggedIn = false
  let username: string | null = null
  let selectedTier: ModelTier = 'flagship'
  try {
    const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as {
      gateway?: {
        apiKey?: string
        baseUrl?: string
        selectedModelId?: string
        account?: { username?: string; nickname?: string }
        models?: GatewayModel[]
        customModels?: GatewayModel[]
        approvalPolicy?: 'ask' | 'never'
      }
    }
    const g = cfg.gateway
    if (g?.apiKey) {
      loggedIn = true
      username = g.account?.nickname ?? g.account?.username ?? null
      gatewayApiKey = g.apiKey
      gatewayBaseUrl = g.baseUrl ?? ''
      // 恢复缓存的模型列表（登录时已存），否则用当前模型兜底保证下拉有内容
      gatewayModels = Array.isArray(g.models) && g.models.length > 0
        ? g.models
        : g.selectedModelId
          ? [{ id: g.selectedModelId, name: g.selectedModelId, tier: selectedTier, apiKey: g.apiKey, baseUrl: g.baseUrl ?? '' }]
          : []
    }
    // 无论登录态，恢复用户上次选中的模型（登录后优先沿用）
    if (g?.selectedModelId) currentModelId = g.selectedModelId
    // 恢复用户自定义模型（标记 custom: true，登录态无关）
    if (Array.isArray(g?.customModels)) {
      customModels = g.customModels.map((m) => ({ ...m, custom: true }))
    }
    // 审批策略（安全模式）已是会话级：从各会话事件日志回放（approval/policy 事件），无需从 config.json 全局恢复
  } catch {
    // 无凭证，未登录
  }

  // —— 其余能力（并行会话：每个会话独立的中断标记）——
  const stoppedSessions = new Set<string>()

  // 装配底座服务（声明式 inject）
  await kernel.plugin({
    name: 'session-service',
    provide: ['session'],
    apply: (ctx) => ctx.provide('session', sessionRef),
  })
  await kernel.plugin({
    name: 'approval-service',
    provide: ['approval'],
    apply: (ctx) => ctx.provide('approval', approval),
  })
  await kernel.plugin({
    name: 'agent-service',
    inject: ['session', 'approval'],
    provide: ['agent'],
    apply: (ctx) => ctx.provide('agent', () => new AgentLoop(model, tools, sessionRef, approval)),
  })

  // —— 多专家编排（Triage 拆解 → 路由专家 → 依赖调度 → 汇总）——
  // 内置专家角色：每个专家 = 通用运行时 + 专属 systemPrompt。工具集复用全部基础工具，避免专家缺工具导致任务失败。
  const BUILTIN_ROLES: RoleDefinition[] = [
    { id: 'general', name: '通用助手', description: '日常问答、对话、信息整理', systemPrompt: '', toolSet: [], skillSet: [] },
    { id: 'code', name: '代码专家', description: '读写代码、执行命令、排查 bug', systemPrompt: '你是「代码专家」，专注于读写代码、执行 shell 命令、排查 bug，输出严谨并给出行号与根因。', toolSet: [], skillSet: [] },
    { id: 'writer', name: '写作专家', description: '撰写文档、文案润色', systemPrompt: '你是「写作专家」，专注于撰写文档、润色文字、结构化表达。', toolSet: [], skillSet: [] },
    { id: 'analyst', name: '分析专家', description: '数据分析、信息提取与总结', systemPrompt: '你是「分析专家」，专注于数据分析、信息提取与总结，结论条理清晰。', toolSet: [], skillSet: [] },
  ]
  const roleNameById = new Map(BUILTIN_ROLES.map((r) => [r.id, r.name]))
  const triage = new ModelTriage(model, BUILTIN_ROLES)
  // 专家执行轨迹回调（UI 展示多专家协作过程）
  const expertTraceCallbacks = new Set<(trace: StepTrace) => void>()

  /** 构造专家池：每个角色一个 AgentLoop（独立 Session 记录执行过程，审批路由到主会话） */
  const buildExpertAgents = (sid: string): Map<string, AgentLoop> => {
    const map = new Map<string, AgentLoop>()
    for (const role of BUILTIN_ROLES) {
      const expertSession = new Session()
      map.set(role.id, new AgentLoop(model, tools, expertSession, approval, sid))
    }
    return map
  }

  /** 专家专属 systemPrompt（含环境信息 + 长期记忆 + 角色人设），由 Orchestrator 在每步注入 */
  const buildExpertSystemPrompts = (workDir: string, message: string): Map<string, string> => {
    const base = buildSystemPrompt(workDir, buildMemoryContext(message))
    const map = new Map<string, string>()
    for (const role of BUILTIN_ROLES) {
      map.set(role.id, role.systemPrompt ? `${base}\n\n${role.systemPrompt}` : base)
    }
    return map
  }

  /**
   * 在指定会话内跑一次任务（run / resend / resume 共用）。
   * 图片降级 + ReAct 循环 + 中断处理 + 落盘。
   */
  const runInSession = async (
    sid: string,
    message: string,
    opts?: { maxSteps?: number; attachments?: ContentPart[] },
  ): Promise<string> => {
    const meta = sessions.get(sid)
    if (!meta) throw new Error(`会话不存在: ${sid}`)
    const targetSession = meta.session
    stoppedSessions.delete(sid)
    // 本轮任务开始时清零 turn 统计（会话级），模型每次返回 usage 时重新累计
    const statAcc = sessionStats(sid)
    statAcc.turnPrompt = 0
    statAcc.turnCompletion = 0
    statAcc.turn = 0
    statAcc.turnCachedPromptTokens = 0
    emitTokenStats(sid)
    // 图片降级：当前模型不支持视觉时，先用视觉模型把图片转成文字描述，再发给当前模型。
    // 关键：降级只影响「发给模型的内容」（modelContent），落盘的 user/message 仍保留原始文本 + 原始图片附件，
    // 这样重启后历史记录里的图片能恢复显示，而不是变成【图片】描述文字。
    let modelContent: string | undefined
    const currentModelMeta = gatewayModels.find((m) => m.id === currentModelId)
    if (opts?.attachments && opts.attachments.length > 0 && !modelSupportsVision(currentModelMeta)) {
      const parts: string[] = []
      for (const p of opts.attachments) {
        if (p.type === 'image_url') {
          parts.push(`【图片】${await analyzeImageWithVision(p.image_url.url)}`)
        }
      }
      const desc = parts.filter(Boolean).join('\n')
      modelContent = message ? `${message}\n\n${desc}` : desc
    }
    // —— 多专家编排入口：Triage 拆解（复杂任务拆多步路由专家，简单任务单步走现有 ReAct）——
    // 拆解失败（模型/网络/解析异常）自动退化为单步，绝不阻断主流程
    try {
      const plan = await sessionContext.run(sid, () => triage.route(message))
      if (plan.steps.length > 1) {
        // 多步编排：先落盘用户消息（专家用独立 Session，主会话手动记录用户消息 + 最终回复）
        targetSession.append('user/message', { content: message, attachments: (opts?.attachments ?? []) as unknown[] })
        targetSession.append('turn/start', { turn: 1 })
        const orchestrator = new Orchestrator(triage, buildExpertAgents(sid), {
          sessionId: sid,
          expertNames: roleNameById,
          expertSystemPrompts: buildExpertSystemPrompts(meta.workDir, message),
          onStep: (trace) => expertTraceCallbacks.forEach((cb) => cb(trace)),
          onDelta: (text) => {
            if (stoppedSessions.has(sid)) throw new Error('__stopped__')
            deltaCallbacks.forEach((cb) => cb(sid, text))
          },
          onReasoning: (text) => {
            reasoningCallbacks.forEach((cb) => cb(sid, text))
          },
        })
        const result = await sessionContext.run(sid, () => orchestrator.run(message))
        targetSession.append('assistant/message', { content: result.text })
        targetSession.append('turn/end', { turn: 1, text: result.text })
        return result.text
      }
    } catch (err) {
      // Triage 拆解异常：退化单步
      console.error('[orchestrator] Triage 拆解异常，退化单步:', err instanceof Error ? err.message : err)
    }
    const loop = new AgentLoop(model, tools, targetSession, approval, sid)
    try {
      return await sessionContext.run(sid, () =>
        loop.run(message, {
          ...opts,
          // 系统提示词告知当前工作目录：让模型知道文件/命令操作的锚点，并约束工具调用围绕工作目录
          systemPrompt: buildSystemPrompt(meta.workDir, buildMemoryContext(message)),
          attachments: opts?.attachments,
          modelContent,
          onDelta: (text) => {
            if (stoppedSessions.has(sid)) throw new Error('__stopped__')
            deltaCallbacks.forEach((cb) => cb(sid, text))
          },
          onReasoning: (text) => {
            reasoningCallbacks.forEach((cb) => cb(sid, text))
          },
        }),
      )
    } catch (err) {
      if (err instanceof Error && err.message === '__stopped__') {
        return '（已中断，历史已保留，可点击「继续执行」续跑）'
      }
      throw err
    } finally {
      // 会话事件（用户消息/助手回复/工具过程）已追加到 session，立即落盘，重启不丢
      await persistSession(meta)
      // 刷新底部状态栏（累计轮次随 turn/end 变化，成功/失败/中断后都要同步）
      emitTokenStats()
    }
  }

  return {
    kernel,
    session: sessionRef,
    tools,
    model,
    memory,
    credentials,
    voice,
    computerUse,
    browserUse,

    loggedIn,
    username,
    async login(u, p) {
      const s = await authService.login(u, p)
      loggedIn = true
      username = s.nickname ?? s.username
      // 拉取会员模型列表（含 apiKey + baseUrl），登录后切换到真实网关模型（不再是 mock）
      const models = await authService.fetchModels(s.token)
      const first = models[0]
      if (first) {
        gatewayModels = models.map((m) => ({ ...m, tier: inferTier(m.id) }))
        gatewayApiKey = first.apiKey
        gatewayBaseUrl = first.baseUrl
        const cached = currentModelId
        // 默认模型：优先用户上次选择 → 项目主力 deepseek-v4-flash → 列表第一个
        const target =
          gatewayModels.find((m) => m.id === cached) ??
          gatewayModels.find((m) => m.id === 'deepseek-v4-flash') ??
          gatewayModels[0]
        if (target) {
          currentModelId = target.id
          model = new DeepSeekProvider({ apiKey: gatewayApiKey, baseUrl: gatewayBaseUrl, model: currentModelId, onUsage })
        }
      }
      refreshContextLength()
      await persistLoginToken(s.token, s.username, { nickname: s.nickname, avatar: s.avatar }, {
        apiKey: gatewayApiKey,
        baseUrl: gatewayBaseUrl,
        selectedModelId: currentModelId,
        models: gatewayModels,
      })
      return { username: s.nickname ?? s.username, nickname: s.nickname }
    },
    async logout() {
      loggedIn = false
      username = null
      gatewayApiKey = ''
      gatewayBaseUrl = ''
      gatewayModels = []
      // 只清除登录凭证字段，保留用户自定义模型 + 选中模型偏好
      try {
        const path = join(homedir(), '.shanhai', 'config.json')
        let cfg: Record<string, unknown> = {}
        try {
          cfg = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
        } catch {
          // 新文件
        }
        const g = (cfg.gateway as Record<string, unknown> | undefined) ?? {}
        delete g.memberToken
        delete g.apiKey
        delete g.baseUrl
        delete g.account
        delete g.models
        cfg.gateway = g
        await fs.writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
      } catch {
        // 忽略持久化失败
      }
      // 恢复模型：优先当前选中的自定义模型（不依赖登录），否则回退 mock
      const customTarget = customModels.find((m) => m.id === currentModelId)
      if (customTarget?.apiKey && customTarget?.baseUrl) {
        model = new DeepSeekProvider({ apiKey: customTarget.apiKey, baseUrl: customTarget.baseUrl, model: customTarget.model ?? customTarget.id, onUsage })
      } else {
        model = await createGatewayModel(onUsage)
      }
      refreshContextLength()
    },
    async listModels() {
      // 系统内置 + 用户自定义（自定义 custom: true，UI 分组展示）
      return allModels()
    },
    async addCustomModel(input) {
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const custom: GatewayModel = {
        id,
        name: input.name || input.model,
        model: input.model,
        tier: 'flagship',
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        custom: true,
      }
      customModels = [...customModels, custom]
      await persistCustomModels(customModels)
      return custom
    },
    async updateCustomModel(id, input) {
      const existing = customModels.find((m) => m.id === id)
      if (!existing) throw new Error(`自定义模型不存在: ${id}`)
      const updated: GatewayModel = {
        id: existing.id,
        name: input.name || input.model,
        model: input.model,
        tier: existing.tier,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        contextLength: existing.contextLength,
        maxTokens: existing.maxTokens,
        temperature: existing.temperature,
        supportsVision: existing.supportsVision,
        supportsReasoning: existing.supportsReasoning,
        provider: existing.provider,
        sortOrder: existing.sortOrder,
        description: existing.description,
        source: existing.source,
        custom: true,
      }
      customModels = customModels.map((m) => (m.id === id ? updated : m))
      // 若正在使用该模型，同步更新 provider
      if (currentModelId === id && updated.apiKey && updated.baseUrl) {
        model = new DeepSeekProvider({ apiKey: updated.apiKey, baseUrl: updated.baseUrl, model: updated.model ?? updated.id, onUsage })
      }
      await persistCustomModels(customModels)
      return updated
    },
    async removeCustomModel(id) {
      customModels = customModels.filter((m) => m.id !== id)
      if (currentModelId === id) {
        currentModelId = ''
        model = await createGatewayModel(onUsage)
      }
      refreshContextLength()
      await persistCustomModels(customModels)
    },
    selectedTier,

    listSessions() {
      return [...sessions.values()].map((s) => ({ id: s.id, title: s.title, workDir: s.workDir }))
    },
    switchSession(id) {
      const target = sessions.get(id)
      if (target) {
        currentSessionId = id
        sessionRef = target.session
        // 会话级审批策略：切到该会话时同步全局默认（供该会话无 approval/policy 事件时兜底）
        approval.setPolicy(effectiveApprovalPolicy(target.session.list()) ?? 'ask')
        // 切会话时广播该会话的 token 统计（底部状态栏会话级隔离）
        emitTokenStats(id)
      }
    },
    renameSession(id, title) {
      const meta = sessions.get(id)
      if (!meta) return
      const trimmed = title.trim()
      if (!trimmed) return
      meta.title = trimmed
      void persistSession(meta)
    },
    async deleteSession(id) {
      const meta = sessions.get(id)
      if (!meta) return
      // 删除会话前，拒绝该会话所有待审批请求，避免 agent 永久卡在 await
      for (const [requestId, p] of pendingApprovals) {
        if (p.sessionId === id) {
          p.resolve('rejected')
          pendingApprovals.delete(requestId)
        }
      }
      // 同样拒绝该会话待确认的 browser 半投递（round-trip 审批）
      for (const [requestId, p] of pendingClientRuns) {
        if (p.sessionId === id) {
          p.resolve(false)
          pendingClientRuns.delete(requestId)
        }
      }
      sessions.delete(id)
      await fs.rm(join(sessionsDir, `${id}.json`), { force: true }).catch(() => undefined)
      // 当前会话被删：切到剩余第一个；无剩余则新建一个空会话
      if (currentSessionId === id) {
        const next = sessions.values().next().value as SessionMeta | undefined
        if (next) {
          currentSessionId = next.id
          sessionRef = next.session
        } else {
          newSession('新会话')
        }
      }
    },
    getSessionWorkdir(id) {
      const meta = sessions.get(id ?? currentSessionId ?? '')
      return meta?.workDir ?? join(homedir(), 'shanhai', 'workspace')
    },
    setSessionWorkdir(id, workdir) {
      const meta = sessions.get(id)
      if (!meta) return
      const trimmed = workdir.trim()
      if (!trimmed) return
      meta.workDir = trimmed
      void persistSession(meta)
    },
    async saveUploadedFile(fileName, dataBase64) {
      const dir = currentWorkDir()
      await fs.mkdir(dir, { recursive: true })
      // 防路径穿越：只取文件名（丢弃任何路径部分），加时间戳前缀避免重名覆盖
      const safeName = `${Date.now()}-${basename(fileName || 'file')}`
      const target = join(dir, safeName)
      await fs.writeFile(target, Buffer.from(dataBase64, 'base64'))
      return target
    },
    async listBrowserWindows(sessionId) {
      const sid = sessionId ?? currentSessionId ?? ''
      const all = await browserUse.list()
      // 会话级隔离：只返回该会话（appId 等于 sid 或 sid: 前缀）的窗口
      return all.filter((w) => w.appId === sid || w.appId.startsWith(`${sid}:`))
    },
    async showBrowserWindow(appId) {
      await browserUse.show(appId)
    },
    async closeBrowserWindow(appId) {
      await browserUse.close(appId)
    },
    getSessionHistory(id) {
      const target = sessions.get(id ?? currentSessionId ?? '')
      if (!target) return []
      const out: Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[] }> = []
      for (const e of target.session.list()) {
        if (e.type === 'user/message') {
          const d = e.data as { content: string; attachments?: unknown[] }
          out.push({ kind: 'user', content: d.content, attachments: d.attachments })
        } else if (e.type === 'assistant/message') {
          const d = e.data as { content: string; reasoningContent?: string }
          out.push({ kind: 'assistant', content: d.content, reasoningContent: d.reasoningContent })
        } else if (e.type === 'tool/call') {
          const d = e.data as { callId: string; name: string; args: Record<string, unknown> }
          out.push({ kind: 'tool', trace: { kind: 'tool-call', sessionId: target.id, callId: d.callId, name: d.name, args: d.args } })
        } else if (e.type === 'tool/result') {
          const d = e.data as { callId: string; name: string; result?: unknown; error?: string }
          out.push({ kind: 'tool', trace: { kind: 'tool-result', sessionId: target.id, callId: d.callId, name: d.name, result: d.result, error: d.error } })
        }
      }
      return out
    },
    getSessionTrace(id) {
      const target = sessions.get(id ?? currentSessionId ?? '')
      if (!target) return []
      const out: Array<{
        role: 'system' | 'user' | 'assistant' | 'tool'
        content: string
        reasoningContent?: string
        toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
        toolCallId?: string
        turn: number
        timestamp: number
      }> = []
      let turn = 0
      for (const e of target.session.list()) {
        if (e.type === 'turn/start') {
          turn = (e.data as { turn: number }).turn
        } else if (e.type === 'user/message') {
          const d = e.data as { content: string; attachments?: unknown[] }
          out.push({ role: 'user', content: d.content, turn, timestamp: e.timestamp })
        } else if (e.type === 'assistant/message') {
          const d = e.data as { content: string; reasoningContent?: string }
          out.push({ role: 'assistant', content: d.content, reasoningContent: d.reasoningContent, turn, timestamp: e.timestamp })
        } else if (e.type === 'tool/call') {
          const d = e.data as { callId: string; name: string; args: Record<string, unknown>; reasoningContent?: string }
          out.push({ role: 'assistant', content: '', reasoningContent: d.reasoningContent, toolCalls: [{ id: d.callId, name: d.name, args: d.args }], turn, timestamp: e.timestamp })
        } else if (e.type === 'tool/result') {
          const d = e.data as { callId: string; name: string; result?: unknown; error?: string }
          const text = d.error ?? (typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? ''))
          out.push({ role: 'tool', content: text, toolCallId: d.callId, turn, timestamp: e.timestamp })
        }
        // assistant/delta 是流式中间态（最终内容在 assistant/message），approval/* 为审批痕迹，轨迹面板聚焦消息痕迹
      }
      return out
    },
    createSession(title, workdir) {
      return newSession(title ?? '新会话', workdir)
    },
    getHistory() {
      const target = sessions.get(currentSessionId ?? '')
      if (!target) return []
      const out: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }> = []
      for (const e of target.session.list()) {
        if (e.type === 'user/message') {
          out.push({ role: 'user', content: (e.data as { content: string }).content })
        } else if (e.type === 'assistant/message') {
          out.push({ role: 'assistant', content: (e.data as { content: string }).content })
        } else if (e.type === 'tool/call') {
          out.push({ role: 'tool', content: '', toolName: (e.data as { name: string }).name })
        } else if (e.type === 'tool/result') {
          const d = e.data as { result?: unknown; error?: string }
          out.push({ role: 'tool', content: JSON.stringify(d.result ?? d.error ?? '') })
        }
      }
      return out
    },

    onToolTrace(cb) {
      toolTraceCallbacks.add(cb)
      return () => toolTraceCallbacks.delete(cb)
    },
    onApprovalRequest(cb) {
      approvalCallbacks.add(cb)
      return () => approvalCallbacks.delete(cb)
    },
    respondApproval(outcome, requestId) {
      const p = pendingApprovals.get(requestId)
      if (p) {
        p.resolve(outcome)
        pendingApprovals.delete(requestId)
      }
    },

    onDelta(cb) {
      deltaCallbacks.add(cb)
      return () => {
        deltaCallbacks.delete(cb)
      }
    },

    onReasoning(cb) {
      reasoningCallbacks.add(cb)
      return () => {
        reasoningCallbacks.delete(cb)
      }
    },

    getTokenStats() {
      return snapshot()
    },
    onTokenStats(cb) {
      tokenCallbacks.add(cb)
      return () => {
        tokenCallbacks.delete(cb)
      }
    },

    switchModel(modelId) {
      currentModelId = modelId
      // 从系统/自定义模型中找到目标，用其 apiKey + baseUrl + model 参数（自定义模型用自有 Key）
      const target = allModels().find((m) => m.id === modelId)
      if (target?.apiKey && target?.baseUrl) {
        model = new DeepSeekProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, onUsage })
      }
      refreshContextLength()
      // 持久化选中模型到 config.json（下次打开不再重复选择）
      void persistSelectedModel(modelId)
    },
    getCurrentModelId() {
      return currentModelId
    },
    stop() {
      if (currentSessionId) stoppedSessions.add(currentSessionId)
    },

    run: async (message, opts) => {
      const sid = currentSessionId
      if (!sid) throw new Error('没有活动会话')
      return runInSession(sid, message, opts)
    },

    resend: async (sessionId, userMessageIndex, newContent) => {
      const meta = sessions.get(sessionId)
      if (!meta) throw new Error(`会话不存在: ${sessionId}`)
      const events = meta.session.list()
      // 定位第 userMessageIndex 条用户消息（0 起），拿到原内容
      let userCount = 0
      let targetIdx = -1
      let originalContent = ''
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e?.type === 'user/message') {
          if (userCount === userMessageIndex) {
            targetIdx = i
            originalContent = (e.data as { content: string }).content
            break
          }
          userCount++
        }
      }
      if (targetIdx < 0) throw new Error(`用户消息不存在: #${userMessageIndex}`)
      const content = newContent !== undefined ? newContent : originalContent
      // 截断到该用户消息之前（丢弃它及其后的回复/工具过程），重新生成
      meta.session.truncate(targetIdx)
      return runInSession(sessionId, content)
    },

    resume: async (sessionId) => {
      const meta = sessions.get(sessionId)
      if (!meta) throw new Error(`会话不存在: ${sessionId}`)
      const events = meta.session.list()
      let lastUserIdx = -1
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'user/message') {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) throw new Error('没有可继续的消息')
      const content = (events[lastUserIdx]!.data as { content: string }).content
      meta.session.truncate(lastUserIdx)
      return runInSession(sessionId, content)
    },

    hasIncompleteTurn(sessionId) {
      const meta = sessions.get(sessionId)
      if (!meta) return false
      const events = meta.session.list()
      let lastUserIdx = -1
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'user/message') {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) return false
      // 该用户消息之后若已有 assistant/message 或 turn/end，说明本轮已完成
      for (let i = lastUserIdx + 1; i < events.length; i++) {
        const t = events[i]?.type
        if (t === 'assistant/message' || t === 'turn/end') return false
      }
      return true
    },

    getApprovalPolicy() {
      return sessionApprovalPolicy()
    },

    setApprovalPolicy(policy) {
      const meta = currentSessionId ? sessions.get(currentSessionId) : undefined
      if (!meta) return
      // 会话级：向当前会话事件日志追加 approval/policy 事件（持久化到会话 JSON，重启后回放恢复）
      meta.session.append('approval/policy', { policy })
      approval.setPolicy(policy)
      void persistSession(meta)
    },

    selfmodInspect(sessionId) {
      const sid = sessionId ?? currentSessionId ?? ''
      return selfmod.inspect(sid)
    },

    onClientRunRequest(cb) {
      clientRunCallbacks.add(cb)
      return () => clientRunCallbacks.delete(cb)
    },

    respondClientRun(requestId, approved) {
      const p = pendingClientRuns.get(requestId)
      if (p) {
        p.resolve(approved)
        pendingClientRuns.delete(requestId)
      }
    },

    onClientCode(cb) {
      clientCodeCallbacks.add(cb)
      return () => clientCodeCallbacks.delete(cb)
    },

    onClientRemove(cb) {
      clientRemoveCallbacks.add(cb)
      return () => clientRemoveCallbacks.delete(cb)
    },

    onExpertTrace(cb) {
      expertTraceCallbacks.add(cb)
      return () => expertTraceCallbacks.delete(cb)
    },

    listMemory() {
      return memory.list()
    },

    removeMemory(id) {
      memory.remove(id)
      void persistMemory()
    },
  }
}
