import type { ToolContract } from '@shanhai/tools'
import type { ApprovalPolicy } from '@shanhai/session'

/** 「会话管家」超级会话的固定 id（独立常驻窗口承载，作为主 Agent 监控/转发所有用户会话） */
export const SUPERVISOR_ID = 'supervisor'

/**
 * 会话管家（主 Agent）工具集。
 *
 * 管家是一个独立的超级会话（固定 id=SUPERVISOR_ID，独立常驻窗口承载），通过这套工具：
 * - 查看所有用户会话的当前状态（busy / 模型 / 审批策略 / 当前需求 / 已执行步数 / 上下文占用）；
 * - 向任意会话转发消息（等同用户手动切过去发消息，走正常队列/插入逻辑）；
 * - 切换任意会话使用的模型 / 安全模式（等同用户手动配置）。
 *
 * 这些工具只注入管家会话，普通用户会话拿不到「管理所有会话」的能力。
 */

/** 单个会话的状态摘要（管家 list_sessions / inspect_session 返回） */
export interface SessionStateSummary {
  id: string
  title: string
  workDir: string
  /** 是否正在执行任务（运行态，内存态） */
  busy: boolean
  /** 是否当前激活会话（聊天窗口当前正在显示的会话，等同用户侧边栏高亮项） */
  active: boolean
  /** 当前生效模型 id（可能为空 = 未登录/默认） */
  modelId: string
  /** 当前生效模型显示名（可能为空） */
  modelName: string
  /** 会话级审批策略（安全模式） */
  approvalPolicy: ApprovalPolicy
  /** 当前需求（最后一条非注入的用户消息，空串 = 无） */
  currentRequest: string
  /** 当前轮已执行的工具步数（最后一个 turn/start 之后的 tool/call 数量） */
  stepCount: number
  /** 当前模型上下文窗口长度（0 = 未知） */
  contextLength: number
  /** 最近一次请求 prompt tokens（已占用上下文） */
  lastPrompt: number
  /** 上下文窗口占比 0~1 */
  contextUsageRatio: number
  /** 已完成轮次（一次「用户消息 → 最终回复」= 一轮） */
  turnCount: number
  /** 是否有未完成轮次（可继续执行） */
  hasIncompleteTurn: boolean
  /** 是否有失败重试挂起快照 */
  hasRetrySnapshot: boolean
  /** 多专家编排运行中的专家数（非多专家为 0） */
  expertCount: number
  /** 最近活跃时间戳 */
  lastActiveAt: number
}

/** 管家工具集闭包捕获的上下文（由 bootstrap 注入真实实现） */
export interface SupervisorContext {
  /** 列出所有用户会话（非管家）的状态摘要 */
  listSessions(): SessionStateSummary[]
  /** 查询单个会话详情（不存在返回 null） */
  inspectSession(sessionId: string): SessionStateSummary | null
  /** 列出可用模型（id + 显示名），供 set_session_model 选择 */
  listModels(): Array<{ id: string; name: string }>
  /** 向指定会话发消息（等同手动切过去发），mode=insert 追加 / queue 排队 */
  sendMessage(sessionId: string, message: string, mode: 'insert' | 'queue'): Promise<{ ok: boolean; message: string; result?: string }>
  /** 切换管家聚焦会话（仅管家视角，不改变用户聊天窗口当前显示的会话） */
  switchSession(sessionId: string): { ok: boolean; message: string }
  /** 切换指定会话使用的模型（写会话事件日志，不影响正在运行的任务） */
  setSessionModel(sessionId: string, modelId: string): { ok: boolean; message: string }
  /** 配置指定会话的安全模式（写会话事件日志） */
  setSessionApproval(sessionId: string, policy: ApprovalPolicy): { ok: boolean; message: string }
  /** 创建新会话（不切换用户当前激活会话，等同后台新建），返回新会话 id */
  createSession(title?: string, workdir?: string): { ok: boolean; message: string; sessionId?: string }
  /** 重命名指定会话（管家会话不可重命名，等同用户手动改名） */
  renameSession(sessionId: string, title: string): { ok: boolean; message: string }
  /** 删除指定会话（管家会话不可删除，危险操作），返回删除结果 */
  deleteSession(sessionId: string): Promise<{ ok: boolean; message: string }>
  /** 设置指定会话的工作目录（管家会话不可修改），等同用户手动设置工作目录 */
  setSessionWorkdir(sessionId: string, workdir: string): { ok: boolean; message: string }
  /** 弹出会话选择器让用户选择目标会话（阻塞等待），resolve 选中的 sessionId；用户取消返回空串 */
  askSessionPicker(question: string): Promise<string>
  /** 弹出模型选择器让用户选择模型（阻塞等待），resolve 选中的 modelId；用户取消返回空串 */
  askModelPicker(question: string): Promise<string>
}

const MODE_DESC =
  '发送模式：insert=目标会话执行中时追加需求（不打断当前任务，在下一轮模型调用前生效）；queue=目标会话执行中时排队等待当前任务结束后再执行。目标会话空闲时两种模式等价，都是直接作为新任务执行。默认 insert。'

/** 构造管家工具集。所有工具免审批（等同用户手动操作：发消息、切模型、切安全模式本身不审批，副作用由目标会话自己的审批兜底）。 */
export function createSupervisorTools(ctx: SupervisorContext): ToolContract[] {
  const toSummary = (s: SessionStateSummary): Record<string, unknown> => ({
    id: s.id,
    title: s.title,
    workDir: s.workDir,
    busy: s.busy,
    active: s.active,
    model: s.modelId,
    modelName: s.modelName,
    approvalPolicy: s.approvalPolicy,
    currentRequest: s.currentRequest,
    stepCount: s.stepCount,
    contextUsageRatio: Number(s.contextUsageRatio.toFixed(3)),
    contextLength: s.contextLength,
    turnCount: s.turnCount,
    hasIncompleteTurn: s.hasIncompleteTurn,
    hasRetrySnapshot: s.hasRetrySnapshot,
    expertCount: s.expertCount,
  })

  return [
    {
      name: 'list_sessions',
      description:
        '列出所有用户会话及其当前执行状态：id、标题、是否忙（busy）、当前模型、安全模式、当前需求、已执行步数、上下文占用占比、是否可继续执行等。' +
        '用于回答「现在有哪些会话在干活」「各会话进度如何」这类问题。只读，不改变任何状态。',
      inputSchema: { type: 'object', properties: {} },
      riskLevel: 'readonly',
      execute: async () => ctx.listSessions().map(toSummary),
    },
    {
      name: 'inspect_session',
      description:
        '查看单个会话的完整状态详情（含当前需求、已执行步数、上下文占用、待审批数等）。' +
        'sessionId 来自 list_sessions 返回的 id。只读，不改变任何状态。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '会话 id（来自 list_sessions）' },
        },
        required: ['sessionId'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const s = ctx.inspectSession(String(args.sessionId ?? ''))
        if (!s) return { ok: false, message: `会话不存在: ${args.sessionId}` }
        return toSummary(s)
      },
    },
    {
      name: 'list_models',
      description: '列出当前系统可用的模型（id + 显示名），供 set_session_model 切换会话模型时选择。只读。',
      inputSchema: { type: 'object', properties: {} },
      riskLevel: 'readonly',
      execute: async () => ctx.listModels(),
    },
    {
      name: 'switch_session',
      description:
        '切换管家聚焦会话（仅管家视角，不影响用户聊天窗口当前显示的会话）。' +
        'sessionId 来自 list_sessions。切换后汇报管家已聚焦该会话。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '要激活的会话 id（来自 list_sessions）' },
        },
        required: ['sessionId'],
      },
      riskLevel: 'reversible',
      execute: async (args) => ctx.switchSession(String(args.sessionId ?? '')),
    },
    {
      name: 'choose_session',
      description:
        '当用户要下发任务/切换模型/配置/删除某个会话，但没有明确说是哪个会话时，【必须】调用本工具弹出会话选择器让用户从中选择，禁止用文本反问用户（阻塞等待用户选择）。' +
        'question 是选择的目的说明（如「请选择要下发任务的会话」）。resolve 返回用户选中的会话 id，可直接用于后续 send_message / set_session_model 等工具。' +
        '不要在能通过 list_sessions 唯一确定目标时滥用；仅当目标不明确时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '选择的目的说明（如「请选择要下发任务的会话」）' },
        },
        required: ['question'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const question = String(args.question ?? '').trim() || '请选择要操作的会话'
        const sessionId = await ctx.askSessionPicker(question)
        if (!sessionId) return { ok: false, message: '用户取消了选择' }
        return { ok: true, sessionId, message: `用户选择了会话 ${sessionId}` }
      },
    },
    {
      name: 'choose_model',
      description:
        '当用户要切换某个会话的模型，但没有明确说是哪个模型时，【必须】调用本工具弹出模型选择器让用户从中选择，禁止用文本反问用户（阻塞等待用户选择）。' +
        'question 是选择的目的说明（如「请选择要切换到哪个模型」）。resolve 返回用户选中的模型 id，可直接用于后续 set_session_model。',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '选择的目的说明（如「请选择要切换到哪个模型」）' },
        },
        required: ['question'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const question = String(args.question ?? '').trim() || '请选择模型'
        const modelId = await ctx.askModelPicker(question)
        if (!modelId) return { ok: false, message: '用户取消了选择' }
        return { ok: true, modelId, message: `用户选择了模型 ${modelId}` }
      },
    },
    {
      name: 'send_message',
      description:
        '向指定会话转发一条消息，效果等同于用户手动切换到该会话后输入并发送。' +
        'sessionId 来自 list_sessions；content 是要转发的需求内容。' + MODE_DESC,
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id（来自 list_sessions）' },
          content: { type: 'string', description: '要转发给该会话的需求/消息内容' },
          mode: { type: 'string', enum: ['insert', 'queue'], description: '发送模式，默认 insert' },
        },
        required: ['sessionId', 'content'],
      },
      riskLevel: 'reversible',
      execute: async (args) => {
        const sid = String(args.sessionId ?? '')
        const content = String(args.content ?? '')
        const mode = args.mode === 'queue' ? 'queue' : 'insert'
        if (!content.trim()) return { ok: false, message: '消息内容不能为空' }
        return ctx.sendMessage(sid, content, mode)
      },
    },
    {
      name: 'inject_message',
      description:
        '向正在执行任务的会话追加一条需求（插入模式），不打断当前任务，在下一轮模型调用前生效。' +
        '仅当目标会话正在执行时有效；空闲会话请用 send_message。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id' },
          content: { type: 'string', description: '要追加的需求内容' },
        },
        required: ['sessionId', 'content'],
      },
      riskLevel: 'reversible',
      execute: async (args) => {
        const sid = String(args.sessionId ?? '')
        const content = String(args.content ?? '')
        return ctx.sendMessage(sid, content, 'insert')
      },
    },
    {
      name: 'set_session_model',
      description:
        '切换指定会话使用的模型（等同用户手动在该会话切换模型）。' +
        'sessionId 来自 list_sessions；modelId 来自 list_models。只影响该会话后续对话，不中断正在运行的任务。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id' },
          modelId: { type: 'string', description: '模型 id（来自 list_models）' },
        },
        required: ['sessionId', 'modelId'],
      },
      riskLevel: 'reversible',
      execute: async (args) => ctx.setSessionModel(String(args.sessionId ?? ''), String(args.modelId ?? '')),
    },
    {
      name: 'set_session_approval',
      description:
        '配置指定会话的安全模式（等同用户手动设置）。' +
        'policy 取值：ask=每次询问、workdir=工作目录内免审批、never=自动执行。' +
        'sessionId 来自 list_sessions。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id' },
          policy: { type: 'string', enum: ['ask', 'workdir', 'never'], description: '安全模式' },
        },
        required: ['sessionId', 'policy'],
      },
      riskLevel: 'reversible',
      execute: async (args) => {
        const policy = String(args.policy ?? '') as ApprovalPolicy
        if (policy !== 'ask' && policy !== 'workdir' && policy !== 'never') {
          return { ok: false, message: `无效的安全模式: ${args.policy}（应为 ask/workdir/never）` }
        }
        return ctx.setSessionApproval(String(args.sessionId ?? ''), policy)
      },
    },
    {
      name: 'create_session',
      description:
        '创建一个新的用户会话（等同用户点击「新建会话」）。' +
        'title 是会话标题（缺省「新会话」）；workdir 是工作目录（缺省用户默认工作目录）。' +
        '创建后新会话会出现在会话列表，可继续用 send_message 给它下发任务。不抢占用户当前正在查看的会话。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '会话标题，缺省「新会话」' },
          workdir: { type: 'string', description: '工作目录，缺省用户默认工作目录' },
        },
      },
      riskLevel: 'reversible',
      execute: async (args) => {
        const title = args.title ? String(args.title) : undefined
        const workdir = args.workdir ? String(args.workdir) : undefined
        return ctx.createSession(title, workdir)
      },
    },
    {
      name: 'rename_session',
      description:
        '重命名指定会话（等同用户手动重命名）。sessionId 来自 list_sessions；title 是新标题（非空）。' +
        '会话管家自己的会话不可重命名。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id（来自 list_sessions）' },
          title: { type: 'string', description: '新标题' },
        },
        required: ['sessionId', 'title'],
      },
      riskLevel: 'reversible',
      execute: async (args) => ctx.renameSession(String(args.sessionId ?? ''), String(args.title ?? '')),
    },
    {
      name: 'set_session_workdir',
      description:
        '设置指定会话的工作目录（等同用户手动设置该会话的工作目录）。' +
        'sessionId 来自 list_sessions；workdir 是新的工作目录绝对路径（非空）。' +
        '只影响该会话后续执行的命令/文件操作的工作目录，不影响正在运行的任务。' +
        '会话管家自己的会话不可修改工作目录。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id（来自 list_sessions）' },
          workdir: { type: 'string', description: '新的工作目录绝对路径' },
        },
        required: ['sessionId', 'workdir'],
      },
      riskLevel: 'reversible',
      execute: async (args) => ctx.setSessionWorkdir(String(args.sessionId ?? ''), String(args.workdir ?? '')),
    },
    {
      name: 'delete_session',
      description:
        '删除指定会话（等同用户手动删除，危险操作，不可恢复）。sessionId 来自 list_sessions。' +
        '删除前会拒绝该会话所有待审批请求、取消待回答提问、清理持久化文件；若删的是当前激活会话会自动切到剩余会话。' +
        '会话管家自己的会话不可删除。执行前务必向用户确认目标会话 id 正确。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '要删除的会话 id（来自 list_sessions）' },
        },
        required: ['sessionId'],
      },
      riskLevel: 'irreversible',
      execute: async (args) => ctx.deleteSession(String(args.sessionId ?? '')),
    },
  ]
}
