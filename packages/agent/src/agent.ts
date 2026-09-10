import type { ChatMessage, Model, ModelResponse, ToolCall, ContentPart, Usage } from '@shanhai/llm'
// 网关超时/不可用的稳定标记由 packages/llm 定义（那里负责把 Go 原文归一成中文），这里只认标记 + 兜底原文
import { GATEWAY_ERROR_MARKER } from '@shanhai/llm'
import { toolReasoningContext, type ToolContract } from '@shanhai/tools'
import type { Session } from '@shanhai/session'
import type { ApprovalService } from '@shanhai/approval'

/**
 * 历史 assistant 消息：回放时包进 <replay-assistant>（防「模仿历史口吻/语义延续/把历史旧结论当当前状态、
 * 把历史回放当成本轮已完成」三类幻觉——本项目有多起实测前科）。标签只在「发给模型那一刻」构造，
 * 事件日志（assistant/message）永远落盘原始正文，渲染层与回放都看不到裸标签，也不会二次包裹。
 * 「历史内容不代表本轮结果」这条约束同时由系统提示词的「历史回放隔离」条款承担（两处一致，不冲突）。
 */

/**
 * 用户消息标签（user_query）：所有「用户说的话」进模型上下文时一律包裹进这对标签，覆盖两种来源——
 * 1. 本轮真实用户消息（run() 追加的当前消息）；
 * 2. 历史回放里的用户提问（replayHistory 读出的 user/message）。
 * 两者共用同一标签，靠「位置」区分：上下文中最后一条 <user_query> 才是用户此刻刚提的要求，
 * 在它之前的都是历史回放（仅作来源标记与背景理解）。该区分规则由系统提示词显式声明，模型必须遵守。
 * 注意：标签只在「发给模型的内容」上施加，事件日志（user/message）永远落盘原始文本，
 * 因此渲染层/会话历史/回放都不会看到裸标签，也不会二次包裹（嵌套）。
 */
const USER_QUERY_OPEN = '<user_query>'
const USER_QUERY_CLOSE = '</user_query>'

/**
 * 历史回放标签（replay- 前缀族，与 <user_query> 一样由一条前缀泛化规则覆盖，不进具名名单）：
 *   <replay-assistant>  包「上下文回放里的历史 AI 回复」——标签内是过去发生的事，不是本轮结果、
 *                       不是模型此刻的发言，更不得作为「已完成」的依据（防把历史当本轮已完成的嘴炮）。
 * 铁律与用户消息一致：标签只存在于「发给模型那一刻」的上下文，绝不写进事件日志/落盘正文；
 * 多轮不累积（回放每次都从落盘原文重新构造，不会在旧标签上再套一层）。
 * 历史用户提问不自成一套：它与本轮消息共用 <user_query>（174 口径，靠"最后一条才是当前指令"区分），
 * 所以这里只需要 assistant 一枚，禁止另起第二套回放包裹实现。
 */
const REPLAY_ASSISTANT_OPEN = '<replay-assistant>'
const REPLAY_ASSISTANT_CLOSE = '</replay-assistant>'

/**
 * 系统提示标签族（<system-reminder> 这一族，沿用 workbuddy 的标签化形态，不用裸文本）：
 * <system-reminder data-role="user-context">   外层：系统注入的上下文，不是用户说的话
 *   ├ <user_info>            运行环境明细（只注入在首条用户消息）
 *   ├ <additional_data>
 *   │     └ <current_time>   该条用户消息自己的时间（每条都有；历史用落盘真实时间，本轮用当下）
 *   └ <sh_mandate>           反编造硬约束（每条都有；sh_ 前缀 → 自动进保留标签名单，无需改名）
 * 铁律：整块只在「发给模型那一刻」构造——不落盘、不进事件日志、不进回放；
 *       且一律放在 <user_query> 之外（块在前、用户原话标签在后）。
 */
const SYSTEM_REMINDER_OPEN = '<system-reminder data-role="user-context">'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const USER_INFO_OPEN = '<user_info>'
const USER_INFO_CLOSE = '</user_info>'
const ADDITIONAL_DATA_OPEN = '<additional_data>'
const ADDITIONAL_DATA_CLOSE = '</additional_data>'
const CURRENT_TIME_OPEN = '<current_time>'
const CURRENT_TIME_CLOSE = '</current_time>'
const MANDATE_OPEN = '<sh_mandate>'
const MANDATE_CLOSE = '</sh_mandate>'

/** 系统保留标签名清单（单一真相源之一：逐个登记的「具名标签」，转义 / 检测 / 剥离三处都由它派生） */
const SYSTEM_RESERVED_TAG_NAMES = ['user_query', 'system-reminder', 'additional_data', 'current_time', 'user_info'] as const

/**
 * 系统保留标签「前缀族」（单一真相源之二）：整族由一条泛化规则覆盖，**不逐个登记名字**。
 * - replay-：历史回放标签（回放历史 AI 回复时注入 <replay-assistant>；该族靠这一条前缀规则覆盖，
 *   不进具名名单——否则每加一枚回放标签都要改一次名单，必然漂移。同时兜底旧会话/旧审计日志里的泄漏）。
 * - sh_：系统提示词的协议模块标签族（角色 / 工作方法 / 合规 / 嘴炮铁律 / 台账约定… 全部以 sh_ 开头）。
 *   提示词模块会随协议增删，若把每个标签名一条条加进名单，必然与提示词漂移；用固定前缀 + 一条泛化
 *   规则，新增模块标签自动被转义 / 检测 / 剥离三处覆盖，无需再改正则。
 */
const SYSTEM_RESERVED_TAG_PREFIX_PATTERNS = ['replay-[a-zA-Z][a-zA-Z0-9-]*', 'sh_[a-z][a-z0-9_]*'] as const

/**
 * 上下文块里的时间格式：年月日 + 星期 + 时:分:秒 + 显式 GMT 偏移。
 * 选它的理由：① 模型能直接判先后（有日期也有时分秒，跨天/跨月可比）；② 带星期，判断"周末/工作日"不必换算；
 * ③ 带 GMT 偏移，跨时区或落盘时间与本地不一致时模型能自己校正；④ 不用裸 Unix 秒（弱模型算不来）。
 * 历史消息与本轮消息用同一个格式，避免模型把"格式不同"误读成"来源不同"。
 */
const CONTEXT_TIME_FMT = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
function formatContextTime(ms: number): string {
  const d = new Date(ms)
  const parts = CONTEXT_TIME_FMT.formatToParts(d)
  const pick = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? ''
  const offsetMin = -d.getTimezoneOffset()
  const abs = Math.abs(offsetMin)
  const tz = `GMT${offsetMin >= 0 ? '+' : '-'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`
  return `${pick('year')}年${pick('month')}月${pick('day')}日 ${pick('weekday')} ${pick('hour')}:${pick('minute')}:${pick('second')} ${tz}`
}

/** 转义待包裹文本里可能出现的同款系统保留标签（含带属性形态），防止模型分不清边界（穿模）。 */
function escapeReservedTags(content: string): string {
  return content.replace(SYSTEM_RESERVED_TAG_RE, (tag) => tag.replace(/^</, '&lt;').replace(/>$/, '&gt;'))
}

/** 把用户原话包裹进 <user_query>（本轮消息与历史回放共用；标签外内容一律不是用户指令）。 */
function wrapUserQuery(content: string): string {
  return `${USER_QUERY_OPEN}\n${escapeReservedTags(content)}\n${USER_QUERY_CLOSE}`
}

/** 把历史 AI 回复包裹进 <replay-assistant>（只用于回放，本轮新输出不包；与 wrapUserQuery 同一套转义路径，
 * 标签内正文若自带同款标签会被转义、不会提前闭合穿模；标签内是过去发生的事，不得当作本轮已完成的依据）。 */
function wrapReplayAssistant(content: string): string {
  return `${REPLAY_ASSISTANT_OPEN}\n${escapeReservedTags(content)}\n${REPLAY_ASSISTANT_CLOSE}`
}

/** 系统提示标签块（包在 <user_query> 之前；块内内容不是用户指令）。
 * 结构：外层 <system-reminder>，块内依次 <user_info>（只首条）→ <additional_data>/<current_time>（每条）
 *      → <sh_mandate>（每条，反编造硬约束，放在最靠近用户原话的一侧，弱模型对尾部内容更敏感）。 */
function wrapUserContext(envLines: string[], atMs: number): string {
  const envPart = envLines.length > 0 ? `${USER_INFO_OPEN}\n${envLines.join('\n')}\n${USER_INFO_CLOSE}\n` : ''
  const timePart = `${ADDITIONAL_DATA_OPEN}\n${CURRENT_TIME_OPEN}${formatContextTime(atMs)}${CURRENT_TIME_CLOSE}\n${ADDITIONAL_DATA_CLOSE}`
  return `${SYSTEM_REMINDER_OPEN}\n${envPart}${timePart}\n${SYSTEM_REMINDER_CLOSE}`
}

/** 把环境明细补进某条用户消息已有的上下文块里（幂等：已带 <user_info> 则原样返回）。 */
function injectEnvIntoContextText(text: string, envLines: string[]): string {
  if (!text.startsWith(SYSTEM_REMINDER_OPEN) || text.includes(USER_INFO_OPEN)) return text
  return `${SYSTEM_REMINDER_OPEN}\n${USER_INFO_OPEN}\n${envLines.join('\n')}\n${USER_INFO_CLOSE}\n${text.slice(SYSTEM_REMINDER_OPEN.length + 1)}`
}

/** 剥掉历史回放包裹（供挂起快照落盘用）：只去外层标签，正文原样返回；不是包裹形态则不动。
 * 与 <user_query> 不同——user_query 属于「发给模型的 body」本体，快照必须原样保留才能重发同一请求；
 * 而 replay-assistant 与系统提示标签块一样是「只在发给模型那一刻构造」的注入标签，绝不进事件日志。 */
function unwrapReplayAssistant(text: string): string {
  if (!text.startsWith(REPLAY_ASSISTANT_OPEN) || !text.endsWith(REPLAY_ASSISTANT_CLOSE)) return text
  return text.slice(REPLAY_ASSISTANT_OPEN.length + 1, text.length - REPLAY_ASSISTANT_CLOSE.length - 1)
}

/** 剥掉文本里的系统提示标签块（含块内全部内容），用于「注入内容不进事件日志」。 */
function stripUserContextBlocks(text: string): string {
  return text.replace(new RegExp(`${SYSTEM_REMINDER_OPEN}[\\s\\S]*?${SYSTEM_REMINDER_CLOSE}\\n?`, 'g'), '')
}

/**
 * 系统保留标签模式串（唯一一份；转义 / 检测 / 剥离三处都由它构造，禁止再出现第二处硬编码标签正则）：
 * - 具名标签来自 SYSTEM_RESERVED_TAG_NAMES（一处增删，三处同步生效）；
 * - 前缀族来自 SYSTEM_RESERVED_TAG_PREFIX_PATTERNS（replay- 旧标签 / sh_ 提示词协议模块标签族），
 *   整族一条泛化规则覆盖，新增模块标签不必改这里。
 * ★属性支持是必须的：<system-reminder data-role="user-context"> 带属性，旧写法（只允许 \s* 直接收尾）
 *   根本匹配不上、剥不掉，会让半截属性文本残留在用户可见正文里。故统一用 (?:\s[^>]*)? 允许任意属性。
 * 刻意不匹配通用 HTML/XML 标签（<div>/<span> 等）与转义文本（&lt;...&gt;），避免误伤用户正常展示内容。
 */
const SYSTEM_RESERVED_TAG_PATTERN = `<\\/?(?:${[...SYSTEM_RESERVED_TAG_NAMES, ...SYSTEM_RESERVED_TAG_PREFIX_PATTERNS].join('|')})(?:\\s[^>]*)?>`

/** 剥离用（带 g 标志，全量替换）。 */
const SYSTEM_RESERVED_TAG_RE = new RegExp(SYSTEM_RESERVED_TAG_PATTERN, 'g')

/** 检测用（无 g 标志，避免 test 的 lastIndex 状态污染）。 */
const SYSTEM_RESERVED_TAG_TEST_RE = new RegExp(SYSTEM_RESERVED_TAG_PATTERN)

function hasSystemReservedTag(text: string): boolean {
  return SYSTEM_RESERVED_TAG_TEST_RE.test(text)
}

/** 剥离系统保留标签本身（<user_query> / <replay-xxx> 等），正文原样保留。 */
function stripSystemReservedTags(text: string): string {
  return text.replace(SYSTEM_RESERVED_TAG_RE, '')
}

/**
 * 内核硬校验：模型最终输出若含系统保留标签，则：
 * 1. 把「原始带标签完整输出」落一条 assistant/raw 事件（审计用），由持久化层分流到独立审计文件，不写 events.jsonl；
 * 2. 剥离标签本身、正文原样保留，返回清洗后的正文作为最终输出。
 * 无标签则原样返回。只作用于「本轮模型新输出」（run/runConvergence 的最终 text），不回放历史、不处理 resumeRun 的历史段。
 */
function sanitizeModelOutput(raw: string, session: Session): string {
  if (!hasSystemReservedTag(raw)) return raw
  session.append('assistant/raw', { content: raw })
  return stripSystemReservedTags(raw)
}

export interface AgentLoopOptions {
  maxSteps?: number
  systemPrompt?: string
  /** 流式增量回调（UI 实时逐字渲染用） */
  onDelta?: (text: string) => void
  /** 流式思考增量回调（推理模型先输出 reasoning_content，UI 实时渲染「思考过程」用） */
  onReasoning?: (text: string) => void
  /** 多模态附件（图片/音频/视频） */
  attachments?: ContentPart[]
  /** 发给模型的内容（可选）。图片降级等场景下：落盘仍保留原始 message + attachments，发给模型改用降级后的文字 */
  modelContent?: string
  /** 历史回放保留的最近对话回合数（缺省 MAX_HISTORY_TURNS=20；管家等特殊会话可传入更大值） */
  maxHistoryTurns?: number
  /** 裁剪历史回合时是否保留回合内的工具调用事件（tool/call + tool/result + assistant(tool_calls)）。
   * true=按事件完整回放（管家会话用，保证工具调用历史不丢失、后续决策有依据）；false/缺省=只保留 user + 最终 assistant 正文（普通会话用，压缩上下文体积）。 */
  preserveToolCalls?: boolean
  /** 是否剔除「最后一个未完成轮次」（发新任务 run() 时才传 true）：网络异常中断执行后，历史会残留一条
   * 已发出但没等到 assistant 正文的孤立 user（其后可能有未走完的 tool 消息）。裁剪时若最后一个 user 回合
   * 无最终 assistant 正文，则连同其后的 tool 消息一起丢弃，只回放完整问答轮，避免与新任务的 user 叠成
   * 「连续两条 user、第一条无正文」。resumeRun（断点续跑）与管家会话不传（保持原回放，不裁剪未完成轮）。 */
  dropIncompleteTurn?: boolean
  /** 系统注入的运行环境快照行（单一真相源：由宿主 apps/runtime 的 collectEnvironment 渲染，本包不参与计算）。
   * 只在「发给模型那一刻」拼进首条用户消息前的系统提示标签块，绝不落盘、不进事件日志、不进回放。
   * 未传时本轮不注入环境块（行为与改造前一致）。 */
  userContext?: string[]
}

/**
 * 失败重试挂起快照（可序列化）：重试耗尽后保存「失败节点发给模型的完整 messages 快照 + 重入位置」。
 * 随会话事件（retry/snapshot）落盘，重启后仍可精确重试（用与失败完全一致的 body 重发请求）。
 */
export interface SuspendedSnapshot {
  messages: ChatMessage[]
  step: number
  maxSteps: number
  /** true=已达步数上限、需走收敛；false=正常 ReAct 循环中失败 */
  atLimit: boolean
  /** 失败原因（展示给用户） */
  reason?: string
}

/**
 * AgentLoop：ReAct 循环。
 *
 * 消息 → 模型决策 → 工具审批 → 工具执行 → 结果回喂 → 再决策，直到文本收敛。
 * 每个可观测步骤落一条类型化会话事件（回放即状态）。
 *
 * 流式：模型有 stream 时优先流式，逐步落 assistant/delta（UI 实时逐字渲染）。
 */
export class AgentLoop {
  /** 待注入的用户消息（插入模式）：任务执行中用户追加的消息，在下一个模型调用前以 user 形式追加到上下文 */
  private pendingInjections: string[] = []
  /** 同一会话同一 agent 稳定不变的 user_id：网关前缀缓存隔离 + 命中用（确定性派生，跨请求/跨重启不变） */
  private readonly userId: string
  /** 审批策略会话：审批判断从该会话回放 approval/policy */
  private readonly approvalSession: Session
  /** 是否已被用户中止（点「停止」）：在每轮循环 / 流式每个 chunk / 工具执行前检查，尽快中断 */
  private aborted = false
  /** 运行护栏（P0-7）：上一次工具调用的「工具名+参数」指纹，用于检测「连续用相同参数重复调用同一工具」 */
  private lastToolCallKey = ''
  /** 运行护栏（P0-7）：当前工具调用指纹连续出现的次数（≥3 触发重复调用熔断） */
  private repeatCallCount = 0
  /** 运行护栏（P0-7）：上一次工具结果指纹，用于检测「连续多步结果无实质变化」 */
  private lastResultDigest = ''
  /** 运行护栏（P0-7）：工具结果指纹连续不变的步数（≥5 触发无进展熔断） */
  private noProgressCount = 0
  /** 最后一次 LLM 返回的真实 usage.total_tokens（网关真实返回，非本地估算）：循环中判断上下文是否超窗口用。
   * 用 totalTokens（prompt + completion）判断实际总消耗窗口，而非只看 prompt 部分。
   * 从会话 usage/record 事件恢复；之后每次模型调用后由 recordUsage 更新。 */
  private lastUsageTotalTokens = 0
  /** 挂起状态（任务失败重试耗尽后保存）：messages 快照 + 重入位置，retry() 用相同 body 重新提交 */
  private suspended:
    | (SuspendedSnapshot & {
        onDelta?: (text: string) => void
        onReasoning?: (text: string) => void
      })
    | undefined
  /** 回放出的 user 消息 → 该条消息落盘时的真实时间戳（ms）。只在内存里，不参与序列化/落盘。
   * 用 WeakMap：消息对象被裁剪丢弃后自动回收，不会跨轮累积（注入内容不落盘、不进回放的硬要求）。 */
  private readonly userMessageTimes = new WeakMap<ChatMessage, number>()
  /** 本轮的运行环境快照行（宿主传入，未传 = 不注入环境块），供 retry() 重新注入用 */
  private lastUserContext: string[] | undefined

  constructor(
    private readonly model: Model,
    private readonly tools: ToolContract[],
    private readonly session: Session,
    private readonly approval: ApprovalService,
    private readonly sessionId?: string,
    /** 上下文窗口大小（token 数）：超阈值时把早期对话历史压成摘要（undefined = 不压缩） */
    private readonly budget?: number,
    /** 当前模型是否支持视觉：true 时截图结果（含 https imageUrl）会以多模态形式直接喂给模型「看」 */
    private readonly supportsVision = false,
    /** 当前模型服务的 apiKey：user_id 确定性派生用（区分不同账号/服务商的前缀缓存） */
    private readonly apiKey?: string,
    /** 统一压缩模型：配置了则用该模型做上下文摘要（LLM 压缩），否则回退会话模型（this.model） */
    private readonly compactModel?: Model,
  ) {
    this.approvalSession = this.session
    // 同一会话同一 agent 的 user_id 永远不变（确定性派生，不含时间戳/随机数，跨请求/跨重启稳定）：
    // user_id = sessionId:apiKey，同一账号同会话所有请求共享，前缀缓存稳定累积命中
    this.userId = [sessionId ?? 'agent', apiKey].filter((x): x is string => !!x).join(':')
    this.restoreLastUsageTotalTokens()
  }

  /** 从会话事件日志恢复最近一次真实 usage.totalTokens（循环中 maybeCompact 判断上下文是否超窗口用）。
   * 遍历 usage/record 事件取最后一条 totalTokens，是网关真实返回，不是本地估算。
   * 兼容旧记录：无 totalTokens 时回退 promptTokens。 */
  private restoreLastUsageTotalTokens(): void {
    for (const e of this.session.list()) {
      if (e.type === 'usage/record') {
        const d = e.data as { totalTokens?: number; promptTokens?: number }
        if (typeof d.totalTokens === 'number') this.lastUsageTotalTokens = d.totalTokens
        else if (typeof d.promptTokens === 'number') this.lastUsageTotalTokens = d.promptTokens
      }
    }
  }

  /**
   * 注入一条用户消息（插入模式）：任务执行中用户追加消息时调用。
   * 不中断当前任务——消息先落盘到会话日志（历史完整），并在下一个模型调用前以 user 形式追加到上下文。
   * 多条注入消息按顺序全部追加，不覆盖、不丢失。
   */
  injectUserMessage(message: string): void {
    // 只入队，不立即落盘：立即 session.append 会赶在「工具执行中」（tool/call 已落盘、tool/result 未落盘）
    // 把消息插进二者之间，违背「追加在最后面」的语义，且回放时产生孤立 tool 消息 → 网关 400。
    // 落盘延迟到 runLoop 下一轮开头（当前工具回合已完整结束），保证追加到事件日志末尾。
    this.pendingInjections.push(message)
  }

  /** 把未消费的注入消息落盘到会话日志末尾（供中止时调用，避免追加需求丢失） */
  private flushPendingInjections(): void {
    for (const m of this.pendingInjections.splice(0, this.pendingInjections.length)) {
      this.session.append('user/message', { content: m, injected: true })
    }
  }

  /** 中止当前任务循环（用户点「停止」）：设置标志，run 循环 / 流式 chunk / 工具执行前检查后抛 __stopped__ 尽快退出。
   * 注意：无法真正取消「正在 await 的工具 Promise」（如正在跑的 run_command），但能保证工具执行完立即停止、不进入下一轮。 */
  abort(): void {
    this.aborted = true
  }

  async run(message: string, options?: AgentLoopOptions): Promise<string> {
    const maxSteps = options?.maxSteps ?? 2000
    const maxHistoryTurns = options?.maxHistoryTurns ?? MAX_HISTORY_TURNS
    let messages: ChatMessage[] = []
    if (options?.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })

    // 从 session 事件日志回放历史（多轮对话 + 断点续跑：中断后历史仍在 session）
    // includeReasoning=false：上下文回放（近轮数裁剪、供模型使用）剔除 reasoning_content，避免思维链撑爆上下文、触发超时；
    // 仅 preserveToolCalls=true（按事件完整回放，保留工具调用）时才视为完整事件回放，保留 reasoning_content。
    this.replayHistory(messages, options?.preserveToolCalls === true, maxHistoryTurns)

    // 用户发起的新任务（新发消息 / 编辑重发 / 点击重发）：始终按最近 maxHistoryTurns（缺省 20）轮对话回放（每轮只保留用户消息 + 最终 assistant 回复正文，
    // 丢弃更早历史与工具执行过程），不再全量回放。断点续跑 resumeRun() 走独立路径，保留全量已执行历史。
    // preserveToolCalls=true 时（管家会话），每回合按事件完整回放、保留工具调用（tool/call + tool/result + assistant(tool_calls)）。
    this.trimHistoryToRecentTurns(messages, maxHistoryTurns, options?.preserveToolCalls, options?.dropIncompleteTurn)

    // 追加当前消息（含多模态附件，附件一并写入事件日志，回放时还原）。
    // 落盘永远保留原始 message + attachments（渲染层/会话历史读的都是无标签原文，不会出现裸标签，回放也不会二次包裹）；
    // 只有「发给模型的内容」才用 <user_query> 包裹用户原话——与历史回放（replayHistory）共用同一标签，
    // 靠位置区分当前指令与历史提问（规则见系统提示词）。附件是数据不是用户原话，留在标签外。
    // 发给模型的内容在有 modelContent 时用降级后的文字（如图片降级）
    const attachments = options?.attachments
    this.session.append('user/message', { content: message, attachments: (attachments ?? []) as unknown[] })
    // 发给模型的当前这条用户消息：记下它的当下时间（上下文块用），并持有对象引用供 applyUserContext 注入
    const currentUserMsg: ChatMessage =
      options?.modelContent !== undefined
        // 非视觉模型降级路径：发给模型的是降级后的文字（字符串）
        ? { role: 'user', content: wrapUserQuery(options.modelContent) }
        : this.supportsVision
          ? // 多模态模型：所有用户消息统一用数组结构（标准多模态格式），无附件时也保持数组，
            // 避免 content 一会儿字符串一会儿数组，保证网关/模型对结构一致性不敏感。
            (() => {
              const parts: ContentPart[] = [{ type: 'text', text: wrapUserQuery(message) }]
              if (attachments && attachments.length > 0) parts.push(...attachments)
              return { role: 'user', content: parts }
            })()
          : attachments && attachments.length > 0
            ? { role: 'user', content: [{ type: 'text', text: wrapUserQuery(message) }, ...attachments] }
            : { role: 'user', content: wrapUserQuery(message) }
    this.userMessageTimes.set(currentUserMsg, Date.now())
    messages.push(currentUserMsg)

    // 在「发给模型那一刻」给每条用户消息前置系统提示标签块（环境快照 + 各条自己的时间）。
    // 必须在裁剪之后做：保证环境块落在最终上下文里的第一条用户消息上，不会因早期历史被裁掉而丢失。
    this.lastUserContext = options?.userContext
    this.applyUserContext(messages)

    this.session.append('turn/start', { turn: 1 })
    const onDelta = options?.onDelta
    const onReasoning = options?.onReasoning

    return this.runLoop(messages, 0, maxSteps, onDelta, onReasoning)
  }

  /** 回放会话事件日志到 messages（user/assistant/tool 三类；delta/turn/usage/retry-snapshot 等中间态或元数据事件忽略）。
   * includeReasoning：是否把历史 assistant 消息的 reasoning_content（思维链）带回 messages。
   * - 上下文回放（run() 近轮数裁剪、供模型使用）默认传 false：剔除 reasoning_content，避免思维链撑爆上下文、触发超时；
   * - 完整事件回放（resumeRun 断点续跑 / preserveToolCalls=true 按事件完整回放）传 true：保留 reasoning_content。 */
  private replayHistory(messages: ChatMessage[], includeReasoning = true, maxTurns?: number): void {
    const total = this.session.size
    let start = 0
    if (maxTurns !== undefined && maxTurns > 0) {
      // 发新任务(run)时只回放最近 maxTurns 个 user 回合：从尾部反向扫描（不整体 list() 复制），
      // 定位第 maxTurns 个 user/message 的起点。不足 maxTurns 轮则 start 保持 0（全量回放），与未裁剪时一致。
      let userCount = 0
      for (let i = total - 1; i >= 0; i--) {
        const e = this.session.at(i)
        if (e?.type === 'user/message') {
          userCount++
          if (userCount >= maxTurns) {
            start = i
            break
          }
        }
      }
    }
    for (let i = start; i < total; i++) {
      const e = this.session.at(i)
      if (!e) continue
      if (e.type === 'user/message') {
        const d = e.data as { content: string; attachments?: ContentPart[] }
        // 记下该条消息落盘时的真实时间（事件 timestamp，Date.now() 毫秒）：上下文块里的时间必须用它，
        // 绝不能用「现在」——否则历史消息会被伪装成刚发的，模型把旧提问当当前任务，正是我们要防的嘴炮。
        const atMs = e.timestamp
        if (this.supportsVision) {
          // 多模态模型：历史用户消息统一用数组结构（重发 https 附件），与当前消息结构保持一致；
          // 非视觉模型仍走 replayUserContent 的占位符（避免 400 / 重复计费）。
          // 历史 user 正文与本轮消息同样包裹 <user_query>（共用标签，靠位置区分：最后一条才是当前指令）。
          // 落盘原文里若混进过系统提示标签块（旧版本/异常路径），先剥掉再包裹，避免多轮累积与二次注入。
          const parts: ContentPart[] = []
          if (d.content) parts.push({ type: 'text', text: wrapUserQuery(stripUserContextBlocks(d.content)) })
          if (d.attachments && d.attachments.length > 0) parts.push(...d.attachments)
          const historyMsg: ChatMessage = { role: 'user', content: parts.length > 0 ? parts : [{ type: 'text', text: wrapUserQuery('') }] }
          this.userMessageTimes.set(historyMsg, atMs)
          messages.push(historyMsg)
        } else {
          // 历史附件只回放占位符，不重新发送 base64（避免请求体巨大 / 非视觉模型 400 / 重复计费）
          // 历史 user 正文与本轮消息同样包裹 <user_query>（共用标签，靠位置区分：最后一条才是当前指令）。
          const historyMsg: ChatMessage = { role: 'user', content: wrapUserQuery(stripUserContextBlocks(replayUserContent(d.content, d.attachments))) }
          this.userMessageTimes.set(historyMsg, atMs)
          messages.push(historyMsg)
        }
      } else if (e.type === 'assistant/message') {
        const d = e.data as { content: string; reasoningContent?: string }
        // 历史 assistant 正文：包进 <replay-assistant> 再回放——标签内是「过去发生的事」，不是本轮结果、
        // 不是模型此刻的发言，不得作为「已完成」的依据（防模仿历史口吻/语义延续/把旧结论当当前状态三类幻觉）。
        // 与用户消息同一套做法：只在发给模型这一刻构造，落盘的 assistant/message 永远是原始正文，
        // 所以回放读到的原文不含标签 → 每轮重新包裹一次即可，不会多轮累积成嵌套。
        messages.push({
          role: 'assistant',
          content: wrapReplayAssistant(d.content),
          reasoningContent: includeReasoning ? d.reasoningContent : undefined,
        })
      } else if (e.type === 'tool/call') {
        const d = e.data as { callId: string; name: string; args: Record<string, unknown>; reasoningContent?: string }
        messages.push({ role: 'assistant', content: '', toolCall: { id: d.callId, name: d.name, args: d.args }, reasoningContent: includeReasoning ? d.reasoningContent : undefined })
      } else if (e.type === 'tool/result') {
        const d = e.data as { callId: string; result?: unknown; error?: string }
        messages.push({ role: 'tool', content: JSON.stringify(d.result ?? d.error ?? ''), toolCallId: d.callId })
      }
    }
  }

  /** 用户发起新任务时（run()，即新发消息 / 编辑重发 / 点击重发）始终裁剪历史到最近 MAX_HISTORY_TURNS 个对话回合。
   * 每个回合只保留「用户原始消息 + 最终 assistant 回复正文」，丢弃中间的 tool/call、tool/result、assistant(tool_calls)
   * 工具执行过程，最大程度压缩体积同时保留对话主线。按 user 消息为回合边界，不切断「assistant(tool_calls) ↔ tool」配对
   * （这些过程整体丢弃，不会产生孤立 tool 消息）。历史不足 MAX_HISTORY_TURNS 轮时保留全部（等于未裁剪）。
   * 断点续跑 resumeRun() 不调用本方法，保留全量已执行历史。 */
  private trimHistoryToRecentTurns(
    messages: ChatMessage[],
    maxTurns?: number,
    preserveToolCalls?: boolean,
    dropIncompleteTurn?: boolean,
  ): void {
    const trimmed = this.buildTrimmedMessages(messages, maxTurns, preserveToolCalls, dropIncompleteTurn)
    messages.length = 0
    messages.push(...trimmed)
  }

  /** 裁剪 messages 到最近 maxTurns（缺省 MAX_HISTORY_TURNS）个对话回合，返回新数组：
   * - preserveToolCalls=true：每回合按事件完整保留（user → assistant(tool_calls) → tool → ... → 最终 assistant 正文），不丢弃工具调用；
   * - preserveToolCalls=false/缺省：每回合只保留「用户原始消息 + 最终 assistant 回复正文」，丢弃中间的 tool/call、tool/result、assistant(tool_calls) 工具执行过程。
   * - dropIncompleteTurn=true（发新任务 run():由普通会话传入）：若最后一个 user 回合无最终 assistant 正文（网络中断残留的孤立 user），
   *   连同其后的 tool 消息一起丢弃，只回放完整问答轮，避免与新任务的 user 叠成连续两条 user。resumeRun / 管家不传该标志，保持原回放。
   * 调用方已确认需要裁剪，此处不再判断回合数是否超上限，始终只保留最近 limit 个回合。 */
  private buildTrimmedMessages(
    messages: ChatMessage[],
    maxTurns?: number,
    preserveToolCalls?: boolean,
    dropIncompleteTurn?: boolean,
  ): ChatMessage[] {
    const limit = maxTurns ?? MAX_HISTORY_TURNS
    const systemMsgs = messages.filter((m) => m.role === 'system')
    const rest = messages.filter((m) => m.role !== 'system')
    const userIndices: number[] = []
    rest.forEach((m, i) => {
      if (m.role === 'user') userIndices.push(i)
    })
    const kept: ChatMessage[] = []
    const keptUserIndices = userIndices.slice(-limit) // 最近 limit 个 user 消息在 rest 中的索引
    keptUserIndices.forEach((userIdx, t) => {
      const nextUserIdx = keptUserIndices[t + 1] ?? rest.length // 下一个 user 消息的位置（最后一个回合取 rest 末尾）
      const isLastTurn = t === keptUserIndices.length - 1
      if (preserveToolCalls) {
        // 按事件完整保留该回合：user → assistant(tool_calls) → tool/result → ... → 最终 assistant 正文
        for (let i = userIdx; i < nextUserIdx; i++) {
          const m = rest[i]
          if (m) kept.push(m)
        }
        return
      }
      // 发新任务时剔除「最后一个未完成轮次」：网络中断遗留的孤立 user（其后没有最终 assistant 正文）。
      // 只在最后一个 user 回合且 dropIncompleteTurn=true 时判定，避免误删中间的正常轮次。
      if (dropIncompleteTurn && isLastTurn) {
        let hasFinalText = false
        for (let i = userIdx + 1; i < nextUserIdx; i++) {
          const m = rest[i]
          if (m && m.role === 'assistant' && !isToolCallMessage(m)) {
            hasFinalText = true
            break
          }
        }
        // 无最终 assistant 正文 → 该回合是未完成轮次，连同其后未走完的 tool 消息一起跳过
        if (!hasFinalText) return
      }
      const userMsg = rest[userIdx]
      if (!userMsg) return
      kept.push(userMsg) // 用户发的原始消息
      // 在该回合内倒序找最后一条 assistant 正文（最终回复，无工具调用）；任务中止无正文时该回合只留 user 消息
      for (let i = nextUserIdx - 1; i > userIdx; i--) {
        const m = rest[i]
        if (m && m.role === 'assistant' && !isToolCallMessage(m)) {
          kept.push(m)
          break
        }
      }
    })
    return [...systemMsgs, ...kept]
  }

  /** 在「发给模型那一刻」给每条用户消息前置系统提示标签块（块在前、<user_query> 在后，块内内容不进用户原话标签）：
   * - 每条用户消息：带该条消息自己的时间（历史用它落盘时的真实时间戳，当前消息用当下；
   *   时间未知的消息一律不注入，绝不拿 now 冒充历史时间）；
   * - 上下文里的第一条用户消息：额外带运行环境快照（宿主传入，本包不计算）。
   * 只在内存里构造：落盘的用户消息永远是原文，故注入内容不进 events.jsonl、不进回放、不显示给用户。
   * 幂等：已带块的文本不会被二次注入（retry 复用同一批 messages 对象时安全）。 */
  private applyUserContext(messages: ChatMessage[]): void {
    const envLines = (this.lastUserContext ?? []).filter((l) => l.trim().length > 0)
    let envPlaced = false
    for (const m of messages) {
      if (m.role !== 'user') continue
      const atMs = this.userMessageTimes.get(m)
      const decorate = (text: string): string => {
        // 已带块（retry 复用同一批 messages 对象 / 中途追加后再走一遍）：不重复注入，只可能补一次环境明细
        if (text.startsWith(SYSTEM_REMINDER_OPEN)) {
          if (envPlaced || envLines.length === 0) return text
          envPlaced = true
          return injectEnvIntoContextText(text, envLines)
        }
        // 时间未知（非本层构造的消息，如运行护栏提示、压缩摘要）一律不注入，绝不拿 now 冒充历史时间
        if (atMs === undefined) return text
        const withEnv = !envPlaced && envLines.length > 0
        if (withEnv) envPlaced = true
        return `${wrapUserContext(withEnv ? envLines : [], atMs)}\n${text}`
      }
      if (typeof m.content === 'string') {
        m.content = decorate(m.content)
      } else if (Array.isArray(m.content)) {
        // 多模态数组：只给第一个 text 片段加块，附件（图片/音视频）留在标签外，是数据不是用户原话
        const firstText = m.content.find((p): p is { type: 'text'; text: string } => p.type === 'text')
        if (firstText) firstText.text = decorate(firstText.text)
      }
    }
  }

  /** 深拷贝一份 messages 并剥掉所有「只在发给模型那一刻构造」的注入标签：专给 retry/snapshot 落盘用（注入内容不进事件日志）。
   * - user 消息：剥掉系统提示标签块（环境快照 / 时间 / mandate）；
   * - assistant 消息：剥掉历史回放包裹 <replay-assistant>（它同样是注入标签，落盘会污染事件日志）。
   * 内存里的那份保持原样，同进程 retry 仍能用与失败完全一致的 body 重发请求。 */
  private withoutUserContextBlocks(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => {
      if (m.role === 'assistant' && typeof m.content === 'string') {
        const plain = unwrapReplayAssistant(m.content)
        return plain === m.content ? m : { ...m, content: plain }
      }
      if (m.role !== 'user') return m
      if (typeof m.content === 'string') {
        const stripped = stripUserContextBlocks(m.content)
        return stripped === m.content ? m : { ...m, content: stripped }
      }
      if (Array.isArray(m.content)) {
        let changed = false
        const parts = m.content.map((p) => {
          if (p.type !== 'text') return p
          const stripped = stripUserContextBlocks(p.text)
          if (stripped === p.text) return p
          changed = true
          return { ...p, text: stripped }
        })
        return changed ? { ...m, content: parts } : m
      }
      return m
    })
  }

  /** 断点续跑（「继续执行」用）：从会话事件日志回放已执行的历史（含完整工具回合），不追加新 user 消息、不新建 turn，
   * 直接继续 ReAct 循环。用户停止后 session 日志已完整记录已执行步骤，回放即恢复进度，从断点继续而非重新生成。 */
  async resumeRun(
    systemPrompt: string | undefined,
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
    userContext?: string[],
  ): Promise<string> {
    // 清理上次中断残留的流式增量（半截 assistant/delta）：回放时虽忽略，但残留会污染持久化文件与后续重建
    const events = this.session.list()
    let cut = events.length
    while (cut > 0 && events[cut - 1]?.type === 'assistant/delta') cut--
    if (cut < events.length) this.session.truncate(cut)

    const maxSteps = 2000
    const messages: ChatMessage[] = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    this.replayHistory(messages)
    // 断点续跑同样注入上下文块（历史用它落盘时的真实时间，第一条带环境快照）
    this.lastUserContext = userContext
    this.applyUserContext(messages)
    // 断点续跑不裁剪：保留全量已执行历史，确保从断点继续时上下文完整（按长度裁剪只对用户发起新任务生效，见 run()）
    return this.runLoop(messages, 0, maxSteps, onDelta, onReasoning)
  }

  /**
   * ReAct 循环主体（可重入）：挂起后 retry() 从失败的那一步用「相同 messages 快照」重新进入，
   * 即向 LLM 重新提交与上次失败完全一致的请求 body（上下文数据不变），而非重新回放历史/重新构建。
   */
  private async runLoop(
    messages: ChatMessage[],
    startStep: number,
    maxSteps: number,
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    for (let step = startStep; step < maxSteps; step++) {
      // 用户点「停止」：每轮开始即检查，尽快中断（覆盖工具执行完回到循环、以及 reasoning/正文流式之前）
      if (this.aborted) {
        // 中止时 flush 未消费的注入消息落盘（此时工具回合已完整结束，位置在末尾），避免追加需求丢失
        this.flushPendingInjections()
        throw new Error('__stopped__')
      }
      // 插入模式：任务执行中用户追加的消息，在下一个模型调用前一次性追加到上下文（多条全部追加，不覆盖丢失）。
      // 用「追加需求」标记 + 编号列表注入，并指示模型在最终回答正文里单独回应，让追加的需求/问题在输出中显式体现。
      if (this.pendingInjections.length > 0) {
        const injected = this.pendingInjections.splice(0, this.pendingInjections.length)
        // 落盘：此处上一轮工具回合（tool/call + tool/result）已完整落盘，追加到事件日志末尾才是「最后面」
        for (const m of injected) this.session.append('user/message', { content: m, injected: true })
        const list = injected.map((m, i) => `${i + 1}. ${m}`).join('\n')
        // 追加的用户需求也是「用户说过的话」：先建对象记下当下时间，再统一由 applyUserContext 补上下文块
        const injectedMsg: ChatMessage = {
          role: 'user',
          content: `【任务执行期间，用户追加了以下新需求/新问题】\n${list}\n\n请按以下步骤处理，不要中断原有任务：\n1. 继续完成原有任务。\n2. 对上述每条新增需求逐条评估：判断是否需要在当前任务内实际执行、是否可行、优先级如何。\n3. 对可执行的新增需求，请像处理原任务一样调用工具实际去完成（不要只做文字回应），直到这些新增需求也得到落实；确实无法完成的需求，说明原因。\n4. 全部完成后，在最终回答正文中用「新增需求完成情况」小节，按上述编号逐条列出：需求内容 → 评估结论 → 完成状态（已完成 / 部分完成 / 无法完成并说明原因）。`,
        }
        this.userMessageTimes.set(injectedMsg, Date.now())
        messages.push(injectedMsg)
        // 追加的用户需求同样补一条它自己时刻的上下文块（applyUserContext 幂等：已带块的历史消息不会被二次注入）
        this.applyUserContext(messages)
      }
      // 压缩：token 超预算时把早期对话历史压成摘要，避免上下文窗口溢出
      messages = await this.maybeCompact(messages)
      let response: ModelResponse
      try {
        response = await this.decideWithRetry(messages, onDelta, onReasoning)
      } catch (err) {
        // 兜底：网关明确告知上下文超限（真实值，非本地估算）时，强制压缩后重试一次——
        // 覆盖「resume 首轮无 usage」「压缩漏触发」「摘要请求本身超限」等预防性压缩没拦住的情况
        if (isContextLengthError(err)) {
          const compacted = await this.maybeCompact(messages, true)
          if (compacted === messages) throw err
          messages = compacted
          try {
            response = await this.decideWithRetry(messages, onDelta, onReasoning)
          } catch (err2) {
            // 压缩后仍失败（可能是重试耗尽）：挂起，保存当前 messages 快照供 retry 重提交相同 body
            if (err2 instanceof Error && err2.message.startsWith('__retry_exhausted__')) {
              this.suspend(messages, step, maxSteps, onDelta, onReasoning, false, retryExhaustedReason(err2))
            }
            throw err2
          }
        } else {
          // 重试耗尽：挂起（保存失败节点的 messages 快照），任务保持上下文可重试
          if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
            this.suspend(messages, step, maxSteps, onDelta, onReasoning, false, retryExhaustedReason(err))
          }
          throw err
        }
      }
      const toolCalls = response.toolCalls ?? (response.toolCall ? [response.toolCall] : [])
      if (toolCalls.length > 0) {
        // 一次响应可能返回多个工具调用（OpenAI 并行 tool_calls）：逐个执行，结果依次回喂
        for (const tc of toolCalls) {
          // 运行护栏（P0-7）：记录本次调用的「工具名+参数」指纹，用于「连续用相同参数重复调用」检测
          const key = `${tc.name}::${JSON.stringify(tc.args ?? {})}`
          if (key === this.lastToolCallKey) {
            this.repeatCallCount++
          } else {
            this.lastToolCallKey = key
            this.repeatCallCount = 1
          }
          const digest = await this.handleToolCall(messages, tc, response.reasoningContent)
          // 无进展检测：结果指纹与上一步相同则累计（结果无实质变化）
          if (digest === this.lastResultDigest) {
            this.noProgressCount++
          } else {
            this.lastResultDigest = digest
            this.noProgressCount = 0
          }
        }
        // 熔断判定：重复调用 / 无进展触发后注入护栏提示，让模型停止空转、改用其它方法或向用户求助
        if (this.repeatCallCount >= 3) {
          const toolName = this.lastToolCallKey.split('::')[0] ?? '该工具'
          messages.push({
            role: 'user',
            content: `[运行护栏] 你已连续 ${this.repeatCallCount} 次用相同参数调用 ${toolName}，但结果没有变化。请停止重复调用，改用其它方法，或向用户求助说明卡点。`,
          })
          this.repeatCallCount = 0
          this.lastToolCallKey = ''
        } else if (this.noProgressCount >= 5) {
          messages.push({
            role: 'user',
            content: `[运行护栏] 最近连续 ${this.noProgressCount} 步工具调用没有产生实质进展（结果无变化）。请停止空转，重新审视任务：改用其它方法，或向用户求助。`,
          })
          this.noProgressCount = 0
        }
        continue
      }
      const text = sanitizeModelOutput(response.text ?? '', this.session)
      this.session.append('assistant/message', { content: text, reasoningContent: response.reasoningContent })
      this.session.append('turn/end', { turn: 1, text })
      // 兜底：最终回答轮期间用户仍可能插入消息（竞态窗口），此时任务已收尾、不再发起下一轮 LLM 请求，
      // 落盘这些注入消息（injected 标记）避免完全丢失。它们不会发给模型（任务已结束），但保留在历史末尾。
      this.flushPendingInjections()
      return text
    }
    // 达到步数上限：不直接抛错，追加一条强制收敛指令，让模型基于已有执行结果直接给出最终结论
    messages.push({
      role: 'user',
      content: `已到达最大工具调用步数（${maxSteps} 步）。请不要再调用任何工具，基于以上已完成的执行结果，直接给出最终结论。`,
    })
    try {
      return await this.runConvergence(messages, maxSteps, onDelta, onReasoning)
    } catch (err) {
      // 收敛请求也失败（重试耗尽）：挂起，保存含收敛指令的 messages 快照供 retry
      if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
        this.suspend(messages, maxSteps, maxSteps, onDelta, onReasoning, true, retryExhaustedReason(err))
      }
      throw err
    }
  }

  /** 步数上限后的强制收敛：让模型直接给最终结论（不再调工具） */
  private async runConvergence(
    messages: ChatMessage[],
    maxSteps: number,
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<string> {
    const final = await this.decideWithRetry(messages, onDelta, onReasoning)
    const finalCalls = final.toolCalls ?? (final.toolCall ? [final.toolCall] : [])
    if (finalCalls.length > 0) {
      // 极端情况：模型仍坚持调用工具（如陷入死循环），保留保护性报错
      throw new Error(`agent loop did not converge within ${maxSteps} steps`)
    }
    const text = sanitizeModelOutput(final.text ?? '', this.session)
    this.session.append('assistant/message', { content: text, reasoningContent: final.reasoningContent })
    this.session.append('turn/end', { turn: 1, text })
    return text
  }

  /** 挂起任务：保存失败节点的 messages 快照 + 重入位置，供 retry() 用「相同 body」重新提交。
   * 同时落盘 retry/snapshot 事件（覆盖旧快照），重启后可从会话事件恢复精确重试。 */
  private suspend(
    messages: ChatMessage[],
    step: number,
    maxSteps: number,
    onDelta: ((text: string) => void) | undefined,
    onReasoning: ((text: string) => void) | undefined,
    atLimit: boolean,
    reason?: string,
  ): void {
    this.suspended = { messages: [...messages], step, maxSteps, onDelta, onReasoning, atLimit, reason }
    // 落盘快照（先移除旧快照再 append，保证事件日志里最多一条、且反映「当前是否有挂起任务」）
    // ★落盘前剥掉系统提示标签块：注入内容只在「发给模型那一刻」存在，绝不进 events.jsonl（内存里那份保持原样，
    //   同进程 retry 仍用与失败完全一致的 body 重发）。
    this.session.removeLast('retry/snapshot')
    this.session.append('retry/snapshot', {
      messages: this.withoutUserContextBlocks(messages),
      step,
      maxSteps,
      atLimit,
      reason,
    })
  }

  /** 用户点击「重试」：用失败节点相同的 messages 快照重新提交请求，继续循环（不重新开始、不重新回放历史）。
   * 重启恢复场景：onDelta/onReasoning 从外部传入（快照里无函数），保证流式思考/正文仍能实时回显。 */
  async retry(onDelta?: (text: string) => void, onReasoning?: (text: string) => void): Promise<string> {
    const s = this.suspended
    if (!s) throw new Error('没有挂起的任务可重试')
    this.suspended = undefined
    // 清理挂起快照（无论重试成败；若重试又失败，suspend 会重新落盘新快照）
    this.session.removeLast('retry/snapshot')
    const d = onDelta ?? s.onDelta
    const r = onReasoning ?? s.onReasoning
    if (s.atLimit) {
      return this.runConvergence(s.messages, s.maxSteps, d, r)
    }
    return this.runLoop(s.messages, s.step, s.maxSteps, d, r)
  }

  /** 从持久化快照恢复挂起态（重启后精确重试用）：onDelta/onReasoning 不随快照序列化，retry 时由运行时重新绑定 */
  restoreSuspended(snapshot: SuspendedSnapshot): void {
    this.suspended = { ...snapshot, messages: [...snapshot.messages], onDelta: undefined, onReasoning: undefined }
  }

  /** 是否处于挂起状态（供运行时判断 retry 后 loop 是否仍需保留） */
  isSuspended(): boolean {
    return this.suspended !== undefined
  }

  /** 循环中压缩：最近一次真实 usage.total_tokens 达到窗口 70% 临界值（COMPACTION_THRESHOLD）时，仅针对「当前轮」（最后一条 user 消息之后已执行的工具调用与结果）
   * 做 LLM 摘要，生成一段本轮进度摘要，保证本轮任务连贯性后继续执行。历史回合保持原文不动——超过上下文窗口临界值的
   * 历史也保留、不裁剪、不丢弃（用户发起新任务时已按最近 20 轮裁剪，见 trimHistoryToRecentTurns）。
   * 判断依据：lastUsageTotalTokens（最后一次 LLM 返回的真实 usage.total_tokens），不是本地估算。
   * @param force true 时跳过判断直接压缩（网关已返回 400 超限时的兜底强制压缩）；若当前轮尚无可压缩步骤且非 force，则保留原样返回（不裁剪历史）。 */
  private async maybeCompact(messages: ChatMessage[], force = false): Promise<ChatMessage[]> {
    if (!this.budget) return messages
    // 触发条件：force（网关已返回 400 超限的兜底）或 最近一次真实 usage.total_tokens 达到窗口 70% 临界值（COMPACTION_THRESHOLD，用户设定）。
    const threshold = Math.floor(this.budget * COMPACTION_THRESHOLD)
    if (!force && this.lastUsageTotalTokens <= threshold) return messages

    // 定位「当前轮」：最后一条 user 消息（即当前这条新消息）之后的所有消息 = 本轮已执行的工具步骤
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return messages
    const prefix = messages.slice(0, lastUserIdx + 1) // system + 历史回合 + 当前 user 消息
    const currentTurn = messages.slice(lastUserIdx + 1) // 本轮已执行的步骤
    // 当前轮没有实质工具步骤（空轮，或已被压成摘要只剩 assistant 文本）：说明超限来自历史本身，
    // 压缩当前轮救不了（压完历史仍超会反复压缩），回退裁剪历史到 20 轮。
    const hasToolSteps = currentTurn.some(
      (m) => m.role === 'tool' || (m.role === 'assistant' && isToolCallMessage(m)),
    )
    if (!hasToolSteps) {
      // 当前轮无实质工具步骤（空轮，或已被压成摘要只剩 assistant 文本）：说明超限来自历史本身，压缩当前轮救不了。
      // 非 force（预防性压缩）：按需求「超窗口临界值的历史也保留」，不裁剪历史，直接原样返回（宁可超限报错也不偷偷丢弃历史）。
      // force（网关已明确返回 400「发起即超」）：压缩当前轮救不了，此时必须裁剪历史 20 轮自救——否则注定 400 死循环。
      if (force) {
        const trimmed = this.buildTrimmedMessages(messages)
        // 裁剪后消息数未减少（历史本身不超过 20 轮，无内容可裁）→ 返回原样，让外层抛错（裁剪也救不了）
        if (trimmed.length >= messages.length) return messages
        return trimmed
      }
      return messages
    }

    // 把当前轮步骤转成可读文本喂给摘要器（保留工具调用名+参数、工具结果，才能保证本轮连贯性）。
    // 摘要器走 model.complete 纯文本路径，无工具配对约束，统一压平成 user 文本消息最安全。
    const summaryInput: ChatMessage[] = currentTurn.map((m) => {
      let text = ''
      if (m.role === 'tool') {
        text = `[工具结果] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')}`
      } else if (m.role === 'assistant' && ((m.toolCalls?.length ?? 0) > 0 || m.toolCall)) {
        const calls = (m.toolCalls ?? (m.toolCall ? [m.toolCall] : [])).map(
          (c) => `调用工具 ${c.name}(${JSON.stringify(c.args ?? {})})`,
        )
        text = calls.join('\n')
      } else {
        text = typeof m.content === 'string' ? m.content : ''
      }
      return { role: 'user', content: truncateTextForSummary(text, MAX_SUMMARY_MSG_CHARS) }
    })

    let summary = ''
    // 摘要模型：默认会话模型，配置了统一压缩模型则用配置的（this.compactModel ?? this.model）
    const summaryModel = this.compactModel ?? this.model
    try {
      const res = await summaryModel.complete(
        [
          {
            role: 'system',
            content:
              '你是任务进度摘要器。把「当前这一轮」已执行的工具调用与结果压缩成一段简洁的进度摘要，让模型能据此继续执行：保留已完成的操作、关键结果与结论、尚未完成的部分、下一步该做什么。',
          },
          ...summaryInput,
        ],
        [],
        this.userId,
      )
      summary = res.text ?? ''
    } catch {
      // 摘要失败不阻断主流程：跳过压缩，继续用原文（可能超预算，但至少不崩）
      return messages
    }
    if (!summary) return messages
    return [...prefix, { role: 'user', content: `【本轮执行摘要】${summary}\n\n请基于以上摘要继续完成剩余任务。` }]
  }

  /** 带自动重试的模型决策：可重试错误（网络/超时/5xx/429/余额不足/网关错误）自动重试最多 MAX_AUTO_RETRY 次（指数退避）。
   * 全部失败抛 __retry_exhausted__::<原因>，由上层弹窗让用户选择「重试（保持上下文续跑）/取消」。
   * 用户点「停止」（__stopped__）与上下文超限不自动重试（前者立即中止、后者走专门压缩兜底）。 */
  private async decideWithRetry(
    messages: ChatMessage[],
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<ModelResponse> {
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_AUTO_RETRY; attempt++) {
      try {
        // 每次都是**全新一次请求**：decide() 重新构造 body、重新取 apiKey、重新 fetch（新 AbortController），
        // 不复用上一次失败的响应对象；undici 在连接出错后会把该连接踢出池子，下一次重试是新连接。
        return await this.decide(messages, onDelta, onReasoning)
      } catch (err) {
        if (err instanceof Error && err.message === '__stopped__') throw err
        if (isContextLengthError(err)) throw err
        if (!isRetryableError(err)) throw err
        lastErr = err
        const gateway = isGatewayTimeoutError(err)
        // 用户口径「最多重试 3 次」= **含首次共 4 次尝试**，必须与私信 HTTP 链路（member-channel.httpJson：
        // attempt 0..GATEWAY_RETRY_MAX 共 4 次、播报 3 条）逐项同口径 —— 同一个用户要求不允许两条链路给出两种次数。
        // cap 统一表示「总尝试次数」；其它类别保持既有 5 次尝试（不把已有的抗抖动能力改小）。
        const cap = gateway ? GATEWAY_MAX_RETRY + 1 : MAX_AUTO_RETRY
        if (attempt + 1 >= cap) break
        // 【重试必须可见】静默重试在用户眼里就是卡死。这里在退避之前播报一次「正在重试 N/上限」。
        // 播报口径是「第几次重试 / 最多重试几次」（不是第几次尝试）：网关类上限 3 → 依次 1/3、2/3、3/3；
        // 其它类别沿用既有 max=5 的措辞，一个字符都不改。
        retryNotifier?.({
          sessionId: this.sessionId,
          attempt: attempt + 1,
          max: gateway ? GATEWAY_MAX_RETRY : MAX_AUTO_RETRY,
          reason: retryReasonOf(err),
        })
        const base = gateway ? GATEWAY_ERROR_BACKOFF_MS : isRateLimitError(err) ? RATE_LIMIT_BACKOFF_MS : AUTO_RETRY_BACKOFF_MS
        await sleep(computeBackoffMs(attempt, base))
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
    // 耗尽文案：网关类错误给准确中文说明（含「网关侧上限 10 分钟」这一事实）与下一步建议，**不透传英文原文**
    const reason = isGatewayTimeoutError(lastErr)
      ? `网关持续超时：已重试 ${GATEWAY_MAX_RETRY} 次仍未拿到结果（网关侧单次请求上限 10 分钟）。常见原因是本次请求体过大（例如把图片 base64 塞进了消息）或上游模型排队；可精简内容后点「重试」再发一次`
      : msg
    throw new Error(`__retry_exhausted__::${reason}`)
  }

  private async decide(
    messages: ChatMessage[],
    onDelta?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ): Promise<ModelResponse> {
    if (this.model.stream) {
      let text = ''
      let reasoningContent = ''
      let reasoningFlushed = false
      const toolCalls: ToolCall[] = []
      let usage: Usage | undefined
      try {
        for await (const chunk of this.model.stream(messages, this.tools, this.userId)) {
          // 用户点「停止」：流式每个 chunk 检查（含 reasoning 阶段，此前只在正文 onDelta 回调检查，思考阶段停不下来）
          if (this.aborted) throw new Error('__stopped__')
          if (chunk.reasoningContent) {
            reasoningContent += chunk.reasoningContent
          }
          if (chunk.text) {
            // 最终回答轮：首次遇到正文时，把累积的思考一次性回调到前端（顶部「思考过程」展示）。
            // 工具调用轮的思考不回调（避免堆在顶部），而是通过 toolReasoningContext 关联到对应工具步骤
            if (!reasoningFlushed) {
              reasoningFlushed = true
              if (reasoningContent) onReasoning?.(reasoningContent)
            }
            text += chunk.text
            this.session.append('assistant/delta', { text: chunk.text })
            onDelta?.(chunk.text)
          }
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            toolCalls.push(...chunk.toolCalls)
          } else if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall)
          }
          if (chunk.usage) {
            usage = chunk.usage
            this.recordUsage(chunk.usage)
          }
        }
      } catch (err) {
        throw err
      }
      const response = { text, toolCalls, toolCall: toolCalls[0], reasoningContent: reasoningContent || undefined, usage }
      return response
    }
    let res: ModelResponse
    try {
      res = await this.model.complete(messages, this.tools, this.userId)
    } catch (err) {
      throw err
    }
    if (res.usage) this.recordUsage(res.usage)
    // 非流式模型：只有最终回答轮（无工具调用）才把思考回调到前端，工具轮思考只走 toolReasoningContext
    const resCalls = res.toolCalls ?? (res.toolCall ? [res.toolCall] : [])
    if (resCalls.length === 0 && res.reasoningContent) onReasoning?.(res.reasoningContent)
    return res
  }

  /** 记录每次模型调用返回的 usage，持久化到会话事件日志（usage/record），
   * 供 token 统计模块（累计用量 / 上下文占比）恢复使用，同时更新 lastUsageTotalTokens 供压缩判断用真实值。 */
  private recordUsage(usage: Usage): void {
    this.lastUsageTotalTokens = usage.totalTokens
    this.session.append('usage/record', {
      totalTokens: usage.totalTokens,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens ?? 0,
    })
  }

  private async handleToolCall(messages: ChatMessage[], call: ToolCall, reasoningContent?: string): Promise<string> {
    // 用户点「停止」：工具执行前检查，已中止则不落盘 tool/call、不执行工具，直接中断
    if (this.aborted) {
      this.flushPendingInjections()
      throw new Error('__stopped__')
    }
    const callId = call.id ?? `${call.name}-${Date.now()}`
    // tool/call 事件落盘 reasoningContent：thinking 模式多轮回放时需回传
    this.session.append('tool/call', { callId, name: call.name, args: call.args, reasoningContent })
    // 构造带思维链的 assistant 工具调用消息（回传 reasoning_content 用）
    const assistantCallMsg = (): ChatMessage => ({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: callId, name: call.name, args: call.args }],
      reasoningContent,
    })

    const tool = this.tools.find((t) => t.name === call.name)
    if (!tool) {
      const error = `unknown tool "${call.name}"`
      this.session.append('tool/result', { callId, name: call.name, error })
      messages.push(assistantCallMsg())
      messages.push({ role: 'tool', content: error, toolCallId: callId })
      return `err:unknown-tool:${call.name}`
    }

    // 审批门（会话级审批策略：requiresApproval 从该会话事件日志回放 policy）。
    // 统一入口工具（skill_run）通过 resolveRisk 按 args 动态解析风险（action 级），
    // 未提供 resolveRisk 的工具回退到静态 riskLevel / approvalRequired。
    const dynamicRisk = tool.resolveRisk ? await tool.resolveRisk(call.args) : undefined
    const riskLevel = dynamicRisk?.riskLevel ?? tool.riskLevel
    const approvalRequired = dynamicRisk?.approvalRequired ?? tool.approvalRequired
    const outsideWorkdir = dynamicRisk?.outsideWorkdir
    const forceApproval = dynamicRisk?.forceApproval ?? false
    if (this.approval.requiresApproval({ ...tool, riskLevel, approvalRequired }, this.approvalSession, outsideWorkdir, forceApproval)) {
      const outcome = await this.approval.request(this.approvalSession, {
        id: callId,
        toolName: call.name,
        args: call.args,
        riskLevel,
        sessionId: this.sessionId,
      })
      if (outcome !== 'allowed-once') {
        const error = `approval ${outcome}`
        this.session.append('tool/result', { callId, name: call.name, error })
        messages.push(assistantCallMsg())
        messages.push({ role: 'tool', content: error, toolCallId: callId })
        return `err:approval-${outcome}`
      }
    }

    // 执行（带超时兜底：防止单个工具永久挂起——如浏览器 loadURL 白屏——导致整个任务卡死）。
    // 用 toolReasoningContext 把「这一轮调用工具的思考」注入执行上下文，runtime 工具包装层据此把
    // reasoning 关联到本次工具调用的 trace 上（前端工具步骤卡片折叠展示）。
    try {
      const executed = toolReasoningContext.run(reasoningContent, () => Promise.resolve(tool.execute(call.args)))
      // 超时区分：等用户交互的工具（ask_user / choose_session / choose_model，timeoutMs=Infinity）不设超时——
      // 用户思考/离开多久由用户决定，不该被固定时限打断；其余「等机器/网络/进程」的工具用 timeoutMs（未设则默认兜底），
      // 防止单个工具永久挂起（如浏览器 loadURL 白屏、命令执行卡死）导致整个任务循环被堵塞。
      const result =
        tool.timeoutMs === Infinity ? await executed : await withTimeout(executed, tool.timeoutMs ?? TOOL_TIMEOUT_MS)
      this.session.append('tool/result', { callId, name: call.name, result })
      messages.push(assistantCallMsg())
      messages.push({ role: 'tool', content: JSON.stringify(result), toolCallId: callId })
      // 视觉直看：当前模型支持视觉，且工具结果是截图（含 https imageUrl）时，额外注入图片让模型直接「看」，
      // 而非只看到 imageUrl 字符串（支持视觉的模型能真正理解截图内容，无需再调 image_analyze）
      if (this.supportsVision) {
        const imageUrl = extractImageUrl(result)
        if (imageUrl) {
          messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] })
        }
      }
      return `ok:${JSON.stringify(result)}`
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.session.append('tool/result', { callId, name: call.name, error })
      messages.push(assistantCallMsg())
      messages.push({ role: 'tool', content: `error: ${error}`, toolCallId: callId })
      return `err:${error}`
    }
  }
}

/** 单工具执行超时兜底（毫秒）。run_command 等长任务可能跑很久，给足时间但防止永久挂起卡死整个任务循环。 */
const TOOL_TIMEOUT_MS = 5 * 60 * 1000

/** 模型请求可重试错误（网络/超时/5xx/429/余额不足/网关错误）自动重试次数（全失败后弹窗让用户选择重试/取消） */
const MAX_AUTO_RETRY = 5
/** 自动重试初始退避时间（毫秒），指数增长（500ms → 1s → 2s → 4s） */
const AUTO_RETRY_BACKOFF_MS = 500
/** 限流类错误（429/Throttling）初始退避时间（毫秒），指数增长（1s → 2s → 4s → 8s），比普通可重试错误更保守，给限流器足够冷却时间 */
const RATE_LIMIT_BACKOFF_MS = 1000
/**
 * 网关超时/不可用的退避基数（毫秒），指数增长（3s → 6s → 12s）。
 * 比普通网络抖动（500ms）保守得多：网关报 deadline exceeded 说明上游**已经跑了很久**才失败，
 * 立刻重打只会再撞一次同样的慢路径，白等更久还占着上游额度。
 */
const GATEWAY_ERROR_BACKOFF_MS = 3000
/**
 * 网关超时/不可用的**重试**上限（用户拍板：最多 3 次）。注意语义是「重试次数」，不含首次请求：
 * 含首次共 4 次尝试，与私信 HTTP 链路（member-channel 的 GATEWAY_RETRY_MAX）逐字同口径。
 * 其它类别仍沿用 MAX_AUTO_RETRY（那是「总尝试次数」），不回退既有韧性。
 */
const GATEWAY_MAX_RETRY = 3

/** 用户发起新任务时（新发消息 / 编辑重发 / 点击重发）回放历史保留的最近对话回合数（20 轮：用户原始消息 + 最终 assistant 回复正文） */
const MAX_HISTORY_TURNS = 20

/** 循环中上下文压缩触发临界值：最近一次真实 usage.total_tokens 达到窗口 70% 即触发（预留 30% 余量，用户设定） */
const COMPACTION_THRESHOLD = 0.7

/** 压缩时单条消息内容最多参与摘要的字符数（超过截断，控制摘要请求体积） */
const MAX_SUMMARY_MSG_CHARS = 40000

/** 判断一条 assistant 消息是否为「工具调用」消息（带 toolCall/toolCalls），用于区分「最终回复正文」与「工具调用过程」。 */
function isToolCallMessage(m: ChatMessage): boolean {
  return !!m.toolCall || (m.toolCalls?.length ?? 0) > 0
}

/** 从工具结果中提取 https 图片链接（截图工具返回的 imageUrl），供视觉模型直接「看」。
 * 只接受 http(s) 开头的公网链接，不接受 data: URL / 本地路径，避免误注入。 */
function extractImageUrl(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const r = result as { imageUrl?: unknown }
  if (typeof r.imageUrl === 'string' && /^https?:\/\//.test(r.imageUrl)) return r.imageUrl
  return null
}

/** 判断错误是否为「上下文超限」（网关返回的 invalid_request_error / maximum context length 等）。
 * 这是最权威的「真实超限」信号——网关明确告知请求 token 数超过窗口，据此触发强制压缩兜底。 */
function isContextLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /context length|maximum context|invalid_request_error|too many tokens|reduce the length/i.test(msg)
}

/** 判断错误是否为「可自动重试」（临时性故障：网络抖动/超时/网关 5xx/限流 429/余额或配额不足）。
 * 命中后由 decideWithRetry 自动重试 MAX_AUTO_RETRY 次，全失败再抛 __retry_exhausted__ 弹窗。
 * 注意：__stopped__（用户停止）与上下文超限已在 decideWithRetry 里提前拦截，不会走到这里。 */
/**
 * 【识别网关超时/不可用】三个来源都要覆盖（本项目反复踩过「只匹配一处」）：
 *  ① HTTP 响应 body 的 message 字段 —— 网关把 Go 原文 `context deadline exceeded` 放在 error.message 里透出；
 *     这条已在 packages/llm 归一成带 GATEWAY_ERROR_MARKER 的中文错误（真机 traces 命中 354/232/105 次）；
 *  ② HTTP 502/503/504 —— 同样在 packages/llm 归一（nginx proxy_read_timeout 600s 到点会给我们 504）；
 *  ③ 未经 packages/llm 归一的调用链（自定义 provider / 插件桥）仍可能直接带 Go 原文 → 这里保留原文兜底匹配。
 * 关键：`deadline exceeded` 里既没有「超时」也没有 `timed out`，所以它此前**绕过**了 isRetryableError，
 * 直接以英文原文冒泡到界面 —— 这就是用户看到的「context deadline exceeded」。
 */
function isGatewayTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes(GATEWAY_ERROR_MARKER)) return true
  return /context\s+deadline\s+exceeded|deadline\s+exceeded\s+while\s+reading\s+body|Client\.Timeout\s+exceeded|net\/http:\s+request\s+canceled/i.test(msg)
}

/** 重试播报（给用户的可见反馈）：静默重试在用户眼里就是卡死，比直接报错更糟 */
export interface AgentRetryNotice {
  /** 所属会话（AgentLoop 的 sessionId 本身是可选的，拿不到时宿主只广播到「无路由」并跳过） */
  sessionId?: string
  /** 第几次重试（1-based） */
  attempt: number
  /** 本次错误类别最多允许重试几次 */
  max: number
  /** 中文原因（不含网关英文原文） */
  reason: string
}

let retryNotifier: ((n: AgentRetryNotice) => void) | undefined

/**
 * 宿主（apps/runtime）注入重试播报通道。用模块级 setter 而不是构造参数：
 * AgentLoop 有 6 处构造点，逐个加参数会把改动面摊到整个 runtime；这是一个「进程级输出通道」，
 * 与 deltaCallbacks 同性质，setter 一次接线即可。
 */
export function setAgentRetryNotifier(cb: ((n: AgentRetryNotice) => void) | undefined): void {
  retryNotifier = cb
}

/** 重试原因的中文措辞：不透传网关英文原文，也不把不同原因混成一句「网络异常」 */
function retryReasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (isGatewayTimeoutError(err)) return '网关处理超时'
  if (isRateLimitError(err)) return '触发限流'
  if (/超时|timed?\s*out|ETIMEDOUT/i.test(msg)) return '请求超时'
  if (/5\d\d/.test(msg)) return '网关服务异常'
  return '网络异常'
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // 网关超时/不可用（Go 原文 context deadline exceeded / 502 / 503 / 504）：单独判定，见上面注释
  if (isGatewayTimeoutError(err)) return true
  // 超时
  if (/超时|timed?\s*out|ETIMEDOUT/i.test(msg)) return true
  // 网络层错误（fetch 底层抛出的系统错误 + undici 连接中断类错误）
  // terminated / aborted / UND_ERR_SOCKET / ECONNABORTED / socket hang up 都是 undici 在连接被对端关闭或重置时抛出的
  // 「临时性网络故障」，应纳入自动重试（此前漏掉导致 TypeError: terminated 绕过重试直接冒泡到 IPC 层）
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR_SOCKET|fetch\s*failed|network|socket|terminated|aborted|socket\s*hang\s*up|网络/i.test(msg)) return true
  // HTTP 5xx（网关/服务端临时故障）与 429（限流）
  if (/(?:API|status|HTTP)\s*5\d\d|(?:API|status|HTTP)\s*429/i.test(msg)) return true
  // 429 限流：网关报错形如「upstream error 429: {...}」，429 前无 API/status/HTTP 前缀，裸匹配 429 兜底
  if (/\b429\b/i.test(msg)) return true
  // 限流/节流措辞：Throttling.BurstRate / rate limit / too many requests 等，网关限流可能不带 429 字样也不带「限流」中文
  if (/throttl|burst\s*rate|rate\s*limit|rate\s*exceeded|too\s*many\s*requests/i.test(msg)) return true
  // 余额不足 / 配额 / 限流
  if (/余额不足|insufficient|balance|quota|billing|限流|超额/i.test(msg)) return true
  // 网关错误码（gateway error code N）
  if (/gateway\s*error/i.test(msg)) return true
  return false
}

/** 判断错误是否专属于「限流/节流」（429 / Throttling），区别于网络抖动/5xx 等其它可重试错误，用于给限流更长的指数退避 */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b429\b|throttl|burst\s*rate|rate\s*limit|rate\s*exceeded|too\s*many\s*requests/i.test(msg)
}

/** 指数退避 + 随机抖动：baseMs * 2^attempt，再乘 0.8~1.2 抖动因子，避免多客户端/多任务同步重试再次撞限流 */
function computeBackoffMs(attempt: number, baseMs: number): number {
  const exp = baseMs * 2 ** attempt
  return Math.round(exp * (0.8 + Math.random() * 0.4))
}

/** 从 __retry_exhausted__::<原因> 错误中提取失败原因（无前缀返回 undefined），供挂起快照落盘、前端弹窗展示 */
function retryExhaustedReason(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  if (!err.message.startsWith('__retry_exhausted__::')) return undefined
  return err.message.slice('__retry_exhausted__::'.length)
}

/** 延时（自动重试指数退避用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 摘要输入的单条文本裁剪：超过 MAX_SUMMARY_MSG_CHARS 截断，避免巨型工具结果撑爆摘要请求 */
function truncateTextForSummary(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（内容过长，摘要时已截断）`
}

/** 给 Promise 加超时：超时 reject，正常 resolve/reject 则透传。finally 清理定时器避免泄漏。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`工具执行超时（${Math.round(ms / 1000)}s），已中止本次调用，请检查目标是否可达后重试`)),
      ms,
    )
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 回放历史用户消息：附件（图片/音频/视频）不再重新发送 base64 数据，改用占位符。
 * 原因：历史附件已在上轮被模型处理过；重新发送 base64 会导致请求体巨大、非视觉模型 400、重复计费。 */
function replayUserContent(content: string, attachments?: ContentPart[]): string {
  if (!attachments || attachments.length === 0) return content
  const marks = attachments
    .map((a) => {
      if (a.type === 'image_url') return '[图片附件]'
      if (a.type === 'input_audio') return '[语音附件]'
      if (a.type === 'input_video') return '[视频附件]'
      return ''
    })
    .filter(Boolean)
    .join(' ')
  return content ? `${content} ${marks}` : marks
}
