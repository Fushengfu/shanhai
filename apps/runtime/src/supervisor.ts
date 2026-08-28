import type { ToolContract } from '@shanhai/tools'
import type { ApprovalPolicy } from '@shanhai/session'

/** 「会话管家」超级会话的固定 id（独立常驻窗口承载，作为主 Agent 监控/转发所有用户会话） */
export const SUPERVISOR_ID = 'supervisor'

/** 管家上下文历史回放保留的最近对话回合数（普通会话为 20，管家更多，便于跨会话编排时保留更长上下文主线） */
export const SUPERVISOR_MAX_HISTORY_TURNS = 30

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
  /** 最近若干条非注入的用户消息（按时间从旧到新，用于管家判断会话职责/擅长方向；空数组 = 无历史） */
  recentRequests: string[]
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
  /** 切换激活会话（等同用户在侧边栏点击切换，同步更新聊天窗口当前显示的会话） */
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
  /** 审批请求到达时，管家决策是否批准目标会话的工具执行（outcome=allowed-once 批准 / rejected 拒绝），决策后对应弹窗关闭 */
  resolveApproval(requestId: string, outcome: 'allowed-once' | 'rejected'): { ok: boolean; message: string }
  /** 提问请求到达时，管家代答目标会话的提问（answer 为代答内容，有选项时填选中项、无选项时填文字），代答后对应弹窗关闭 */
  answerAsk(requestId: string, answer: string): { ok: boolean; message: string }
  /** 插件界面组件投递请求到达时，管家决策是否允许把插件 client 半代码投递到界面执行（approved=true 允许 / false 拒绝），决策后对应弹窗关闭 */
  resolveClientRun(requestId: string, approved: boolean): { ok: boolean; message: string }
  /** 断点续跑：对「空闲 + 有未完成轮次」的会话，从事件日志回放已执行历史、从断点继续（不新增用户消息、不篡改历史对话、不重新开始） */
  resumeSession(sessionId: string): Promise<{ ok: boolean; message: string }>
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
    recentRequests: s.recentRequests,
    stepCount: s.stepCount,
    contextUsageRatio: Number(s.contextUsageRatio.toFixed(3)),
    contextLength: s.contextLength,
    turnCount: s.turnCount,
    hasIncompleteTurn: s.hasIncompleteTurn,
    hasRetrySnapshot: s.hasRetrySnapshot,
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
        '切换激活会话（等同用户在侧边栏点击切换，聊天窗口会同步切换到该会话）。' +
        'sessionId 来自 list_sessions。切换后汇报管家已激活该会话。',
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
      guide: {
        usage: [
          '当用户要下发任务/切换模型/配置/删除某个会话，但没有明确说是哪个会话时，必须调用本工具弹出会话选择器让用户选，禁止用文本反问。',
          '仅在能通过 list_sessions 唯一确定目标时跳过；目标不明确时才用。',
        ],
        cautions: [
          '用户取消选择时返回失败，不要继续用猜测的会话。',
        ],
      },
      // 等用户选择：不设超时（用户思考/离开多久由用户决定，不该被 5 分钟统一兜底打断）
      timeoutMs: Infinity,
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
      guide: {
        usage: [
          '当用户要切换某个会话的模型，但没有明确说是哪个模型时，必须调用本工具弹出模型选择器让用户选，禁止用文本反问。',
          '仅在能通过 list_models 唯一确定目标时跳过；目标不明确时才用。',
        ],
        cautions: [
          '用户取消选择时返回失败，不要继续用猜测的模型。',
        ],
      },
      // 等用户选择：不设超时（用户思考/离开多久由用户决定，不该被 5 分钟统一兜底打断）
      timeoutMs: Infinity,
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
      guide: {
        usage: [
          '向指定会话转发消息（等同用户手动切过去发消息），用原样完整转发，不删减、不代办、不合并。',
          'sessionId 来自 list_sessions；多需求时明确的先下发、不明确的单独求助。',
        ],
        cautions: [
          '管家只负责调度转发，不替目标会话执行具体的编码/文件任务。',
        ],
      },
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
      name: 'resume_session',
      description:
        '断点续跑：恢复一个「有未完成轮次且空闲」的会话继续执行，等同用户在该会话点击「继续执行」按钮。' +
        'sessionId 来自 list_sessions；仅当该会话 hasIncompleteTurn=true 且 busy=false（空闲）时有效。' +
        '续跑从会话事件日志回放已执行历史、从断点继续，不新增用户消息、不篡改历史对话、不重新开始。' +
        '非法目标（会话不存在 / 正在执行 / 无未完成轮次 / 管家自身）会被拒绝。' +
        '这是唯一正确的断点续跑方式；用户要求「继续/恢复/续跑」某个中断的会话时必须用本工具，禁止用 send_message 发消息变通（那会新增一条用户消息、把续跑当成新需求）。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id（来自 list_sessions，hasIncompleteTurn=true 且 busy=false）' },
        },
        required: ['sessionId'],
      },
      riskLevel: 'reversible',
      guide: {
        usage: [
          '当用户要求「继续/恢复/续跑」某个中断（未完成轮次）的会话时，用本工具从断点继续，不要用 send_message 发消息变通。',
          '先 list_sessions 确认目标会话 hasIncompleteTurn=true 且 busy=false，再调用。',
        ],
        cautions: [
          '只对「有未完成轮次且空闲」的会话有效；正在执行或已完成轮次的会话会被拒绝。',
          '续跑不新增用户消息、不篡改历史，恢复后仍受该会话安全模式（approvalPolicy）约束。',
        ],
      },
      execute: async (args) => {
        const sid = String(args.sessionId ?? '')
        if (!sid) return { ok: false, message: 'sessionId 不能为空' }
        return ctx.resumeSession(sid)
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
      guide: {
        usage: [
          '用户希望某会话自动执行、不要每次危险操作都弹审批时，用本工具把该会话安全模式设为 never（全自动）或 workdir（工作目录内免审批）。',
          '设置前说明目标会话与模式及后果；设置后该模式持久化到该会话，后续危险操作按新模式判断是否审批。',
        ],
        cautions: [
          '用户没有明确要求时不要擅自把会话改成 never（全自动执行）。',
          'policy 只能取 ask/workdir/never，其它值会报错。',
        ],
      },
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
      guide: {
        usage: [
          '删除会话是危险且不可恢复的操作，执行前必须向用户复述目标会话 id 与标题，得到明确确认后才能删除。',
        ],
        cautions: [
          '会话管家自己的会话不可删除。',
        ],
      },
      execute: async (args) => ctx.deleteSession(String(args.sessionId ?? '')),
    },
    {
      name: 'resolve_approval',
      description:
        '审批请求到达时（管家接管的审批），决定是否批准目标会话的工具执行。' +
        'requestId 来自审批请求通知里的 id；outcome 取 allowed-once（批准）或 rejected（拒绝）。' +
        '决策后对应会话的授权弹窗会自动关闭，目标会话按决策继续或跳过该工具。' +
        '仅在收到【审批请求】通知、且需要替用户把关时调用；只读决策，不执行任何实际文件/命令操作。',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: '审批请求 id（来自【审批请求】通知）' },
          outcome: { type: 'string', enum: ['allowed-once', 'rejected'], description: 'allowed-once=批准执行一次，rejected=拒绝' },
        },
        required: ['requestId', 'outcome'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const requestId = String(args.requestId ?? '')
        const outcome = args.outcome === 'rejected' ? 'rejected' : 'allowed-once'
        if (!requestId) return { ok: false, message: 'requestId 不能为空' }
        return ctx.resolveApproval(requestId, outcome)
      },
    },
    {
      name: 'answer_ask',
      description:
        '提问请求到达时（管家接管的提问），代答目标会话的提问。' +
        'requestId 来自【提问请求】通知里的 id；answer 填代答内容（有可选项时填选中的那一个的原文，无选项时填简短文字）。' +
        '代答后对应会话的提问弹窗会自动关闭，目标会话按你的回答继续执行。' +
        '仅在收到【提问请求】通知、且需要替用户回答时调用；只读决策，不执行任何实际文件/命令操作。',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: '提问请求 id（来自【提问请求】通知）' },
          answer: { type: 'string', description: '代答内容（有选项时填选中项原文，无选项时填简短文字）' },
        },
        required: ['requestId', 'answer'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const requestId = String(args.requestId ?? '')
        const answer = String(args.answer ?? '')
        if (!requestId) return { ok: false, message: 'requestId 不能为空' }
        return ctx.answerAsk(requestId, answer)
      },
    },
    {
      name: 'resolve_client_run',
      description:
        '插件界面组件投递请求到达时（管家接管的投递确认），决定是否允许把插件 client 半代码投递到界面执行。' +
        'requestId 来自【投递请求】通知里的 id；approved 取 true（允许投递）或 false（拒绝投递）。' +
        '决策后对应会话的投递确认弹窗会自动关闭，目标会话按决策继续或中止投递。' +
        '仅在收到【投递请求】通知、且需要替用户把关时调用；只读决策，不执行任何实际代码。',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: '投递请求 id（来自【投递请求】通知）' },
          approved: { type: 'boolean', description: 'true=允许投递到界面，false=拒绝投递' },
        },
        required: ['requestId', 'approved'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const requestId = String(args.requestId ?? '')
        const approved = args.approved === true
        if (!requestId) return { ok: false, message: 'requestId 不能为空' }
        return ctx.resolveClientRun(requestId, approved)
      },
    },
  ]
}
