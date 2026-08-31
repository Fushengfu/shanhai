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
 * 会话实体管理（list_sessions / inspect_session / switch_session / create_session / rename_session /
 * set_session_workdir / delete_session / set_session_model / set_session_approval）已收敛为一个顶层工具
 * session（内部用 action 分派）；会话选择（choose_session）与断点续跑（resume_session）也并入了
 * session（action=choose / action=resume）；其余工具（list_models / choose_model / send_message /
 * inject_message / resolve_approval / answer_ask / resolve_client_run）保持顶层独立。
 *
 * 这些工具只注入管家会话，普通用户会话拿不到「管理所有会话」的能力。
 */

/** 单个会话的状态摘要（管家 session(list) / session(inspect) 返回） */
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
  /** 列出可用模型（id + 显示名 + 类型），供 session(set_model) 选择 */
  listModels(): Array<{ id: string; name: string; modelType?: string }>
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

/**
 * 构造管家工具集。
 *
 * 会话实体管理收敛为单个顶层工具 session（内部 action 分派），其余工具保持顶层独立。
 * 除 session(delete) 外，所有工具免审批（等同用户手动操作：发消息、切模型、切安全模式本身不审批，
 * 副作用由目标会话自己的审批兜底）。session(delete) 是危险不可恢复操作，保留审批/确认语义。
 */
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

  // —— 会话实体管理统一入口：session（action 分派）——
  // 把原 list_sessions / inspect_session / switch_session / create_session / rename_session /
  // set_session_workdir / delete_session / set_session_model / set_session_approval 九个工具
  // 收敛为一个顶层工具，action 枚举 + 入参在 inputSchema 完整说明。
  const sessionTool: ToolContract = {
    name: 'session',
    description:
      '会话实体管理工具（统一入口，用 action 分派）：管理用户会话的增删改查与配置。' +
      'action 取值：' +
      'list —— 列出所有用户会话及其当前执行状态（id、标题、是否忙、当前模型、安全模式、当前需求、已执行步数、上下文占用占比、是否可继续执行等），只读不改变任何状态（无需额外入参）；' +
      'inspect —— 查看单个会话的完整状态详情（入参 sessionId，来自 list 返回的 id），只读；' +
      'switch —— 切换激活会话（等同用户在侧边栏点击切换，聊天窗口同步切换；入参 sessionId）；' +
      'create —— 创建新的用户会话（入参 title? 标题缺省「新会话」、workdir? 工作目录缺省用户默认），返回新会话 id，不抢占用户当前查看的会话；' +
      'rename —— 重命名指定会话（入参 sessionId + title 新标题），管家会话不可重命名；' +
      'set_workdir —— 设置指定会话的工作目录（入参 sessionId + workdir 绝对路径），只影响后续执行，管家会话不可修改；' +
      'delete —— 删除指定会话（入参 sessionId），危险且不可恢复，执行前必须向用户确认目标会话 id 与标题；' +
      'set_model —— 切换指定会话使用的模型（入参 sessionId + modelId 来自 list_models），只影响后续对话，不中断正在运行的任务；' +
      'set_approval —— 配置指定会话的安全模式（入参 sessionId + policy 取值 ask=每次询问/workdir=工作目录内免审批/never=自动执行），持久化到该会话；' +
      'choose —— 弹出会话选择器让用户选目标会话（阻塞等待，入参 question 选择目的说明），返回选中的 sessionId，禁止用文本反问用户；' +
      'resume —— 断点续跑一个「有未完成轮次(hasIncompleteTurn=true)且空闲(busy=false)」的会话（入参 sessionId），从断点继续、不新增用户消息、不篡改历史；非法目标（不存在/正在执行/无未完成轮次/管家自身）会被拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'inspect', 'switch', 'create', 'rename', 'set_workdir', 'delete', 'set_model', 'set_approval', 'choose', 'resume'],
          description:
            '要执行的动作：list 列会话 / inspect 查详情 / switch 切换激活 / create 新建 / rename 重命名 / set_workdir 设工作目录 / delete 删除（危险不可恢复）/ set_model 切换模型 / set_approval 设安全模式 / choose 弹会话选择器 / resume 断点续跑',
        },
        sessionId: { type: 'string', description: '会话 id（list/choose 时不需要；inspect/switch/rename/set_workdir/delete/set_model/set_approval/resume 必填，来自 session(list) 返回的 id）' },
        title: { type: 'string', description: 'create 时：会话标题缺省「新会话」；rename 时：新标题（必填）' },
        workdir: { type: 'string', description: 'create 时：工作目录缺省用户默认；set_workdir 时：新的工作目录绝对路径（必填）' },
        modelId: { type: 'string', description: 'set_model 时：模型 id（来自 list_models，必填）' },
        policy: { type: 'string', enum: ['ask', 'workdir', 'never'], description: 'set_approval 时：安全模式（必填，ask=每次询问/workdir=工作目录内免审批/never=自动执行）' },
        question: { type: 'string', description: 'choose 时：选择的目的说明（如「请选择要下发任务的会话」），必填' },
      },
      required: ['action'],
    },
    riskLevel: 'reversible',
    resolveRisk: (args) => {
      const action = String(args.action ?? '')
      if (action === 'delete') {
        // 删除会话是危险且不可恢复的操作，保留审批/确认语义（不能免审批）
        return { riskLevel: 'irreversible', approvalRequired: true, outsideWorkdir: false }
      }
      if (action === 'list' || action === 'inspect' || action === 'choose') {
        return { riskLevel: 'readonly', approvalRequired: false, outsideWorkdir: false }
      }
      // choose 是只读选择（弹选择器让用户选，不改状态）；resume 属可逆（断点续跑，从断点继续）→ 免审批
      return { riskLevel: 'reversible', approvalRequired: false, outsideWorkdir: false }
    },
    execute: async (args) => {
      const action = String(args.action ?? '')
      if (action === 'list') {
        return ctx.listSessions().map(toSummary)
      }
      if (action === 'inspect') {
        const s = ctx.inspectSession(String(args.sessionId ?? ''))
        if (!s) return { ok: false, message: `会话不存在: ${args.sessionId}` }
        return toSummary(s)
      }
      if (action === 'switch') {
        return ctx.switchSession(String(args.sessionId ?? ''))
      }
      if (action === 'create') {
        const title = args.title ? String(args.title) : undefined
        const workdir = args.workdir ? String(args.workdir) : undefined
        return ctx.createSession(title, workdir)
      }
      if (action === 'rename') {
        return ctx.renameSession(String(args.sessionId ?? ''), String(args.title ?? ''))
      }
      if (action === 'set_workdir') {
        return ctx.setSessionWorkdir(String(args.sessionId ?? ''), String(args.workdir ?? ''))
      }
      if (action === 'delete') {
        return ctx.deleteSession(String(args.sessionId ?? ''))
      }
      if (action === 'set_model') {
        return ctx.setSessionModel(String(args.sessionId ?? ''), String(args.modelId ?? ''))
      }
      if (action === 'set_approval') {
        const policy = String(args.policy ?? '') as ApprovalPolicy
        if (policy !== 'ask' && policy !== 'workdir' && policy !== 'never') {
          return { ok: false, message: `无效的安全模式: ${args.policy}（应为 ask/workdir/never）` }
        }
        return ctx.setSessionApproval(String(args.sessionId ?? ''), policy)
      }
      if (action === 'choose') {
        const question = String(args.question ?? '').trim() || '请选择要操作的会话'
        const sessionId = await ctx.askSessionPicker(question)
        if (!sessionId) return { ok: false, message: '用户取消了选择' }
        return { ok: true, sessionId, message: `用户选择了会话 ${sessionId}` }
      }
      if (action === 'resume') {
        const sid = String(args.sessionId ?? '')
        if (!sid) return { ok: false, message: 'sessionId 不能为空' }
        return ctx.resumeSession(sid)
      }
      throw new Error(`session 未知 action "${action}"：只支持 list / inspect / switch / create / rename / set_workdir / delete / set_model / set_approval / choose / resume`)
    },
  }

  return [
    sessionTool,
    {
      name: 'list_models',
      description: '列出当前系统可用的模型（id + 显示名），供 session({ action: "set_model" }) 切换会话模型时选择。只读。',
      inputSchema: { type: 'object', properties: {} },
      riskLevel: 'readonly',
      execute: async () => ctx.listModels(),
    },
    {
      name: 'choose_model',
      description:
        '当用户要切换某个会话的模型，但没有明确说是哪个模型时，【必须】调用本工具弹出模型选择器让用户从中选择，禁止用文本反问用户（阻塞等待用户选择）。' +
        'question 是选择的目的说明（如「请选择要切换到哪个模型」）。resolve 返回用户选中的模型 id，可直接用于后续 session({ action: "set_model" })。',
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
        'sessionId 来自 session({ action: "list" })；content 是要转发的需求内容。' + MODE_DESC,
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 id（来自 session(list)）' },
          content: { type: 'string', description: '要转发给该会话的需求/消息内容' },
          mode: { type: 'string', enum: ['insert', 'queue'], description: '发送模式，默认 insert' },
        },
        required: ['sessionId', 'content'],
      },
      riskLevel: 'reversible',
      guide: {
        usage: [
          '向指定会话转发消息（等同用户手动切过去发消息），用原样完整转发，不删减、不代办、不合并。',
          'sessionId 来自 session({ action: "list" })；多需求时明确的先下发、不明确的单独求助。',
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
