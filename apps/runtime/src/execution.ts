/**
 * execution 模块：核心执行编排（runInSession / 消息分发 / 管家调度 / 续跑重试）。
 *
 * 从 bootstrap 拆分：原来 runInSession / dispatchToSession /
 * sendMessageToSession / runSession / notifySupervisorResult / drainSupervisorQueue /
 * runSupervisorInternal / drainSupervisorWake / wakeSupervisorFor* / resend / resume /
 * retrySession / abandonSession / hasRetrySnapshot / injectMessage / hasIncompleteTurn
 * 都是 bootstrap 的闭包。现在收敛为 createExecutionModule(ctx, deps)。
 *
 * 这是「组装所有模块并执行」的核心：依赖全部已拆模块（sessions / tokenStats / prompts /
 * modelProvider），但自身不再承担「会话/模型/token/提示词」的具体实现，只做编排。
 */
import type { ContentPart } from '@shanhai/llm'
import type { GatewayModel } from '@shanhai/auth'
import type { ToolContract } from '@shanhai/tools'
import { AgentLoop } from '@shanhai/agent'
import { ASK_CANCELLED, type AskRequest } from '@shanhai/ask'
import type { ApprovalPolicy } from '@shanhai/session'
import { createSupervisorTools, SUPERVISOR_ID, SUPERVISOR_MAX_HISTORY_TURNS, type SessionStateSummary } from './supervisor'
import { createSupervisorLedgerTools } from './supervisor-workspace'
import { modelSupportsVision } from './models'
import { sessionContext, type RuntimeContext, type SessionMeta } from './context'
import type { TokenStatsModule } from './token-stats'
import type { PromptsModule } from './prompts'
import type { ModelProviderModule } from './model-provider'
import type { SessionsModule } from './sessions'

export interface ExecutionModule {
  runInSession(sid: string, message: string, opts?: { maxSteps?: number; attachments?: ContentPart[] }, modelIdOverride?: string, origin?: 'user' | 'supervisor'): Promise<string>
  dispatchToSession(sid: string, message: string, mode: 'insert' | 'queue', onDone: (sid: string, title: string, result?: string, error?: string) => void, origin?: 'user' | 'supervisor'): Promise<{ ok: boolean; message: string; result?: string }>
  sendMessageToSession(sid: string, message: string, mode: 'insert' | 'queue'): Promise<{ ok: boolean; message: string; result?: string }>
  runSession(sid: string, message: string, mode?: 'insert' | 'queue'): Promise<{ ok: boolean; message: string; result?: string }>
  notifySupervisorResult(sid: string, title: string, result?: string, error?: string): void
  drainSupervisorQueue(sid: string): void
  buildSupervisorLoopTools(): ToolContract[]
  runSupervisorInternal(message: string, attachments?: ContentPart[], modelIdOverride?: string): Promise<string>
  drainSupervisorWake(): Promise<void>
  wakeSupervisorForApproval(req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }): void
  wakeSupervisorForAsk(req: AskRequest): void
  wakeSupervisorForResult(sid: string, title: string, result?: string, error?: string): void
  wakeSupervisorForClientRun(req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }): void
  resend(sessionId: string, userMessageIndex: number, newContent?: string): Promise<string>
  resume(sessionId: string): Promise<string>
  retrySession(sessionId: string): Promise<string>
  abandonSession(sessionId: string): Promise<void>
  hasRetrySnapshot(sessionId: string): { reason?: string } | null
  injectMessage(sessionId: string, message: string): boolean
  hasIncompleteTurn(sessionId: string): boolean
}

export function createExecutionModule(
  ctx: RuntimeContext,
  deps: {
    sessions: SessionsModule
    tokenStats: TokenStatsModule
    prompts: PromptsModule
    modelProvider: ModelProviderModule
    allModels: () => GatewayModel[]
    wrapTool: (t: ToolContract) => ToolContract
  },
): ExecutionModule {
  const { sessions, tokenStats, prompts, modelProvider, allModels, wrapTool } = deps

  // 统计会话内「非 injected 的 user/message」数量（turnSeq 计算用）。用 size + at 无复制遍历，
  // 替代 meta.session.list().filter(...).length 的全量复制，消掉 run 前热路径的 O(N) 拷贝。
  const countNonInjectedUserMessages = (session: SessionMeta['session']): number => {
    const total = session.size
    let count = 0
    for (let i = 0; i < total; i++) {
      const e = session.at(i)
      if (e?.type === 'user/message' && !(e.data as { injected?: boolean }).injected) count++
    }
    return count
  }

  const runInSession = async (
    sid: string,
    message: string,
    opts?: { maxSteps?: number; attachments?: ContentPart[] },
    modelIdOverride?: string,
    origin: 'user' | 'supervisor' = 'user',
  ): Promise<string> => {
    const meta = ctx.sessions.get(sid)
    if (!meta) throw new Error(`会话不存在: ${sid}`)
    const targetSession = meta.session
    // 管家超级会话：单步 ReAct + 管家工具集（管家是「主 Agent」，不是被拆解的任务）
    const isSupervisorRun = sid === SUPERVISOR_ID
    // 模型隔离：异步转发（管家给别的会话下发任务）时传 modelIdOverride，用目标会话自己的 provider
    const effModelId = modelIdOverride ?? ctx.currentModelId
    const effModel = modelIdOverride ? modelProvider.resolveProvider(modelIdOverride) : ctx.model
    ctx.stoppedSessions.delete(sid)
    if (!isSupervisorRun) ctx.sessionOrigin.set(sid, origin)
    sessions.touchSession(sid)
    ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, 'start'))
    const statAcc = tokenStats.sessionStats(sid)
    statAcc.turnPrompt = 0
    statAcc.turnCompletion = 0
    statAcc.turn = 0
    statAcc.turnCachedPromptTokens = 0
    tokenStats.emitTokenStats(sid)
    let modelContent: string | undefined
    const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
    if (opts?.attachments && opts.attachments.length > 0 && !visionCapable) {
      const parts: string[] = []
      for (const p of opts.attachments) {
        if (p.type === 'image_url') {
          parts.push(`【图片】${await prompts.analyzeImageWithVision(p.image_url.url)}`)
        }
      }
      const desc = parts.filter(Boolean).join('\n')
      modelContent = message ? `${message}\n\n${desc}` : desc
    }
    const loop = new AgentLoop(effModel, isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools, targetSession, ctx.approval, sid, tokenStats.currentContextBudget(effModelId), visionCapable, tokenStats.currentApiKey(effModelId), modelProvider.resolveCompactModel())
    ctx.runningLoops.set(sid, loop)
    // 发新任务前，物理清理上一个「未完成轮次」的半截事件（普通会话与管家会话一致清理）。
    // 网络中断会把「只有 user、无最终 assistant 正文、无 turn/end 收尾」的半截事件留在事件日志，
    // 污染后续回放/续跑。发新任务(run)即代表放弃对上一个中断任务的断点续跑，故可安全物理删除；
    // 完整轮次（含成对 tool/result、usage/record、model/select 等正常事件）全部保留。
    // dropIncompleteTurn（回放层剔除）仍保留作兜底，与本处落盘清理互补。
    cleanupIncompleteTurnLog(meta)
    let suspended = false
    // 内核事件总线：消息到达（用户消息提交 → assistant 回复完成）都广播给 host 半插件（ctx.on 订阅）。
    // 单个插件监听器异常不影响会话编排主流程（try-catch 吞掉）。
    const safeEmit = (name: string, payload: unknown): void => {
      try {
        ctx.kernel.ctx.emit(name, payload)
      } catch {
        // ignore：插件监听器异常不影响消息编排
      }
    }
    safeEmit('message', { sessionId: sid, role: 'user', content: message })
    try {
      const result = await sessionContext.run(sid, () =>
        loop.run(message, {
          ...opts,
          systemPrompt: isSupervisorRun ? prompts.buildSupervisorSystemPrompt(message) : prompts.buildSystemPrompt(meta.workDir, prompts.buildMemoryContext(message, meta.id)),
          attachments: opts?.attachments,
          modelContent,
          // 管家历史回放轮数比普通会话多（30 vs 20），便于跨会话编排时保留更长上下文主线
          maxHistoryTurns: isSupervisorRun ? SUPERVISOR_MAX_HISTORY_TURNS : undefined,
          // 发新任务（run）时，普通会话与管家会话一致剔除「最后一个未完成轮次」：网络中断遗留的孤立 user（其后无 assistant 正文）。
          // resume 续跑走 resumeRun 不传此标志，天然不受影响。
          dropIncompleteTurn: true,
          // 管家历史回放与普通会话一致：只回放 user + 最终 assistant 正文，不保留工具调用过程（tool/call + tool/result）。
          // 曾用 preserveToolCalls: isSupervisorRun 完整回放工具调用，但会把历史里反复出现的重复工具调用（如 ledger(write) 反复写 _index.json）
          // 回放给模型、强化重复行为，诱发「连续几十次写同一台账文件」的死循环，故取消（走缺省 false）。
          onDelta: (text) => {
            if (ctx.stoppedSessions.has(sid)) throw new Error('__stopped__')
            ctx.deltaCallbacks.forEach((cb) => cb(sid, text))
          },
          onReasoning: (text) => {
            ctx.reasoningCallbacks.forEach((cb) => cb(sid, text))
          },
        }),
      )
      safeEmit('message', { sessionId: sid, role: 'assistant', content: result })
      return result
    } catch (err) {
      if (err instanceof Error && err.message === '__stopped__') {
        return '（已中断，历史已保留，可点击「继续执行」续跑）'
      }
      if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
        suspended = !isSupervisorRun
      }
      throw err
    } finally {
      if (!suspended) {
        ctx.runningLoops.delete(sid)
        ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, 'end'))
      }
      ctx.sessionOrigin.delete(sid)
      meta.lastActiveAt = Date.now()
      await sessions.persistSession(meta)
      tokenStats.emitTokenStats()
      drainSupervisorQueue(sid)
      if (sid === SUPERVISOR_ID && !suspended) {
        console.log('[supervisor-wake] 管家 loop 结束（finally），触发 drain，suspended=', suspended)
        void drainSupervisorWake()
      } else if (sid === SUPERVISOR_ID) {
        console.log('[supervisor-wake] 管家 loop 结束但 suspended=true，不触发 drain')
      }
    }
  }

  async function dispatchToSession(
    sid: string,
    message: string,
    mode: 'insert' | 'queue',
    onDone: (sid: string, title: string, result?: string, error?: string) => void,
    origin: 'user' | 'supervisor' = 'user',
  ): Promise<{ ok: boolean; message: string; result?: string }> {
    const meta = ctx.sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    const content = message.trim()
    if (!content) return { ok: false, message: '消息内容不能为空' }

    const busy = ctx.runningLoops.has(sid)
    if (busy && mode === 'insert') {
      const loop = ctx.runningLoops.get(sid)
      if (loop) {
        loop.injectUserMessage(content)
        return Promise.resolve({ ok: true, message: `已向会话「${meta.title}」(${sid}) 追加需求（不打断当前任务）` })
      }
      return Promise.resolve({ ok: false, message: '注入失败：未找到运行中的任务' })
    }
    if (busy && mode === 'queue') {
      const q = ctx.supervisorQueue.get(sid) ?? []
      q.push(content)
      ctx.supervisorQueue.set(sid, q)
      return Promise.resolve({ ok: true, message: `会话「${meta.title}」(${sid}) 正在执行，需求已排队（当前任务结束后自动执行）` })
    }

    const title = meta.title
    const targetModelId = meta.modelId ?? ctx.defaultModelId
    const turnSeq = countNonInjectedUserMessages(meta.session) + 1
    ctx.userMessageCallbacks.forEach((cb) => cb(sid, content, turnSeq))
    void (async () => {
      try {
        const result = await runInSession(sid, content, undefined, targetModelId, origin)
        onDone(sid, title, result)
      } catch (err) {
        onDone(sid, title, undefined, err instanceof Error ? err.message : String(err))
      }
    })()
    return Promise.resolve({ ok: true, message: `已向会话「${title}」(${sid}) 下发任务，将异步执行` })
  }

  function sendMessageToSession(sid: string, message: string, mode: 'insert' | 'queue'): Promise<{ ok: boolean; message: string; result?: string }> {
    return dispatchToSession(sid, message, mode, (sid, title, result, error) => notifySupervisorResult(sid, title, result, error), 'supervisor')
  }

  function runSession(sid: string, message: string, mode: 'insert' | 'queue' = 'insert'): Promise<{ ok: boolean; message: string; result?: string }> {
    return dispatchToSession(sid, message, mode, () => {}, 'user')
  }

  const notifySupervisorResult = (sid: string, title: string, result?: string, error?: string): void => {
    const text = error
      ? `⚠️ 会话「${title}」(${sid}) 执行失败：${error}`
      : `✅ 会话「${title}」(${sid}) 执行完成：\n\n${result ?? '（无正文输出）'}`
    const supMeta = ctx.sessions.get(SUPERVISOR_ID)
    supMeta?.session.append('assistant/message', { content: text })
    if (supMeta) void sessions.persistSession(supMeta)
    ctx.supervisorResultCallbacks.forEach((cb) => cb(sid, title, result, error))
    wakeSupervisorForResult(sid, title, result, error)
  }

  function drainSupervisorQueue(sid: string): void {
    const queued = ctx.supervisorQueue.get(sid)
    if (!queued || queued.length === 0) return
    const next = queued.shift()
    if (next) void sendMessageToSession(sid, next, 'queue')
  }

  // 管家会话工具白名单：基础工具只保留少量，插件类能力统一收敛到 plugin（统一入口，10 个 action：list / inspect / scaffold / build / test-load / verify / install / publish / uninstall / tool）。
  // 原「plugin_inspect / plugin_define / plugin_scaffold / plugin_build / plugin_install / ...」等 plugin_* 顶层工具，
  // 以及 plugin_manage / plugin_list / plugin_tool 三个入口，均已收敛（见 selfmod.createPluginTool），故白名单只需放行这一个入口。
  // 管家只做会话调度与监控，不执行具体任务，因此不暴露技能调度工具（skill_list / skill_read / skill_run）。
  const SUPERVISOR_ALLOWED_BASE_TOOL_NAMES = new Set([
    'ask_user',
    'remember',
    'recall_memory',
    'plugin',
  ])

  const buildSupervisorLoopTools = (): ToolContract[] => [
    ...ctx.tools.filter((t) => SUPERVISOR_ALLOWED_BASE_TOOL_NAMES.has(t.name)),
    ...createSupervisorTools({
      listSessions: () =>
        [...ctx.sessions.values()]
          .filter((s) => !s.isSupervisor)
          .map((s) => sessions.describeSession(s.id))
          .filter((s): s is SessionStateSummary => s !== null),
      inspectSession: (sid) => sessions.describeSession(sid),
      listModels: () => allModels().map((m) => ({ id: m.id, name: m.displayName ?? m.name ?? m.id, modelType: m.modelType })),
      sendMessage: (sid, message, mode) => sendMessageToSession(sid, message, mode),
      switchSession: (sid) => sessions.switchSessionInternal(sid),
      setSessionModel: (sid, modelId) => sessions.setSessionModelInternal(sid, modelId),
      setSessionApproval: (sid, policy) => sessions.setSessionApprovalInternal(sid, policy),
      createSession: (title, workdir) => {
        const id = sessions.createSessionInternal(title, workdir)
        const created = ctx.sessions.get(id)
        return { ok: true, message: `已创建会话「${created?.title ?? '新会话'}」(${id})`, sessionId: id }
      },
      renameSession: (sid, title) => sessions.renameSessionInternal(sid, title),
      deleteSession: (sid) => sessions.deleteSessionInternal(sid),
      setSessionWorkdir: (sid, workdir) => sessions.setSessionWorkdirInternal(sid, workdir),
      askSessionPicker: (question) =>
        ctx.askService
          .ask(question, {
            kind: 'session-picker',
            sessionOptions: [...ctx.sessions.values()]
              .filter((s) => !s.isSupervisor)
              .map((s) => sessions.describeSession(s.id))
              .filter((s): s is SessionStateSummary => s !== null)
              .map((s) => ({
                id: s.id,
                title: s.title,
                busy: s.busy,
                active: s.active,
                modelName: s.modelName,
                workDir: s.workDir,
                contextUsageRatio: s.contextUsageRatio,
                currentRequest: s.currentRequest,
              })),
            sessionId: SUPERVISOR_ID,
          })
          .then((answer) => (answer === ASK_CANCELLED ? '' : answer)),
      askModelPicker: (question) =>
        ctx.askService
          .ask(question, {
            kind: 'model-picker',
            modelOptions: allModels().map((m) => ({ id: m.id, name: m.displayName ?? m.name ?? m.id })),
            sessionId: SUPERVISOR_ID,
          })
          .then((answer) => (answer === ASK_CANCELLED ? '' : answer)),
      resolveApproval: (requestId, outcome) => {
        const p = ctx.pendingApprovals.get(requestId)
        if (!p) {
          console.log('[supervisor-wake] resolve_approval 未命中：', requestId, 'pendingApprovals 现存=', [...ctx.pendingApprovals.keys()].join(','))
          return { ok: false, message: `审批请求不存在或已处理: ${requestId}` }
        }
        p.resolve(outcome)
        ctx.pendingApprovals.delete(requestId)
        console.log('[supervisor-wake] resolve_approval 已决策：', requestId, outcome)
        ctx.approvalResolvedCallbacks.forEach((cb) => cb(requestId))
        return { ok: true, message: `已${outcome === 'rejected' ? '拒绝' : '批准'}审批请求 ${requestId}` }
      },
      answerAsk: (requestId, answer) => {
        const resolved = ctx.askService.respond(requestId, answer)
        if (!resolved) return { ok: false, message: `提问请求不存在或已处理: ${requestId}` }
        ctx.askResolvedCallbacks.forEach((cb) => cb(requestId))
        return { ok: true, message: `已代答提问 ${requestId}` }
      },
      resolveClientRun: (requestId, approved) => {
        const p = ctx.pendingClientRuns.get(requestId)
        if (!p) {
          console.log('[supervisor-wake] resolve_client_run 未命中：', requestId, 'pendingClientRuns 现存=', [...ctx.pendingClientRuns.keys()].join(','))
          return { ok: false, message: `投递请求不存在或已处理: ${requestId}` }
        }
        p.resolve(approved)
        ctx.pendingClientRuns.delete(requestId)
        console.log('[supervisor-wake] resolve_client_run 已决策：', requestId, approved)
        ctx.clientRunResolvedCallbacks.forEach((cb) => cb(requestId))
        return { ok: true, message: `已${approved ? '允许' : '拒绝'}投递请求 ${requestId}` }
      },
      resumeSession: async (sid) => {
        const meta = ctx.sessions.get(sid)
        if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
        if (ctx.runningLoops.has(sid)) return { ok: false, message: `会话「${meta.title}」(${sid}) 正在执行中，无法断点续跑` }
        if (!hasIncompleteTurn(sid)) return { ok: false, message: `会话「${meta.title}」(${sid}) 没有未完成的轮次，无需续跑` }
        // 断点续跑：resume 从事件日志回放已执行历史、从断点继续（不新增用户消息、不篡改历史对话），
        // 工具执行时的审批判断仍从该会话事件日志回放 approval/policy，即仍受该会话安全模式（approvalPolicy）约束。
        void resume(sid).catch((err) => {
          console.error('[supervisor] session(resume) 续跑失败:', err instanceof Error ? err.message : err)
        })
        return { ok: true, message: `已恢复会话「${meta.title}」(${sid}) 从断点继续执行` }
      },
    }).map(wrapTool),
    ...createSupervisorLedgerTools().map(wrapTool),
  ]

  const runSupervisorInternal = async (message: string, attachments?: ContentPart[], modelIdOverride?: string): Promise<string> => {
    const supMeta = ctx.sessions.get(SUPERVISOR_ID)
    const supModel = modelIdOverride ?? supMeta?.modelId
    const targetModelId = supModel ?? ctx.defaultModelId
    const savedModelId = ctx.currentModelId
    if (targetModelId) modelProvider.applyModel(targetModelId)
    ctx.approval.setPolicy(sessions.sessionApprovalPolicy(SUPERVISOR_ID))
    try {
      return await runInSession(SUPERVISOR_ID, message, attachments ? { attachments } : undefined)
    } finally {
      if (savedModelId) modelProvider.applyModel(savedModelId)
      ctx.approval.setPolicy(sessions.sessionApprovalPolicy())
    }
  }

  async function drainSupervisorWake(): Promise<void> {
    if (ctx.supervisorWaking) {
      console.log('[supervisor-wake] drain 跳过：已有 drain 在跑（supervisorWaking=true），queue=', ctx.supervisorWakeQueue.length)
      return
    }
    if (ctx.runningLoops.has(SUPERVISOR_ID)) {
      console.log('[supervisor-wake] drain 跳过：管家正忙（runningLoops 有 SUPERVISOR_ID），queue=', ctx.supervisorWakeQueue.length)
      return
    }
    ctx.supervisorWaking = true
    console.log('[supervisor-wake] drain 启动，queue=', ctx.supervisorWakeQueue.length)
    try {
      while (ctx.supervisorWakeQueue.length > 0 && !ctx.runningLoops.has(SUPERVISOR_ID)) {
        const prompt = ctx.supervisorWakeQueue.shift()!
        console.log('[supervisor-wake] 取出 prompt 开始处理，剩余 queue=', ctx.supervisorWakeQueue.length)
        try {
          await runSupervisorInternal(prompt)
          console.log('[supervisor-wake] prompt 处理完成')
        } catch (err) {
          console.error('[supervisor-wake] 管家决策处理失败，继续处理队列下一条:', err instanceof Error ? err.message : err)
        }
      }
      console.log('[supervisor-wake] while 退出：queue=', ctx.supervisorWakeQueue.length, 'runningLoops.has=', ctx.runningLoops.has(SUPERVISOR_ID))
    } finally {
      ctx.supervisorWaking = false
      console.log('[supervisor-wake] drain 结束，supervisorWaking=false')
    }
  }

  function wakeSupervisorForApproval(req: { id: string; sessionId?: string; toolName: string; args: Record<string, unknown>; riskLevel: string }): void {
    const sid = req.sessionId ?? ''
    const title = sid ? (ctx.sessions.get(sid)?.title ?? sid) : sid
    const prompt =
      `【审批请求】会话「${title}」请求执行工具 ${req.toolName}（风险等级 ${req.riskLevel}）。\n` +
      `参数：${JSON.stringify(req.args)}\n\n` +
      `请判断是否批准该操作，并调用 resolve_approval 工具决策：requestId="${req.id}"，outcome 取 allowed-once（批准）或 rejected（拒绝）。` +
      `若风险过高或参数可疑请拒绝；不要替该会话执行具体操作。`
    ctx.supervisorWakeQueue.push(prompt)
    const supMeta = ctx.sessions.get(SUPERVISOR_ID)
    const turnSeq = supMeta ? countNonInjectedUserMessages(supMeta.session) + 1 : 1
    ctx.userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq))
    console.log('[supervisor-wake] 审批请求入队：', req.id, req.toolName, 'queue=', ctx.supervisorWakeQueue.length, 'supervisorWaking=', ctx.supervisorWaking, 'runningLoops.has=', ctx.runningLoops.has(SUPERVISOR_ID))
    void drainSupervisorWake()
  }

  function wakeSupervisorForAsk(req: AskRequest): void {
    const sid = req.sessionId ?? ''
    const title = sid ? (ctx.sessions.get(sid)?.title ?? sid) : sid
    const optionsText = req.options && req.options.length > 0 ? `\n可选项：${req.options.map((o) => `「${o}」`).join(' / ')}` : ''
    const prompt =
      `【提问请求】会话「${title}」向你提问：${req.question}${optionsText}\n\n` +
      `请以用户视角判断并回答该问题，调用 answer_ask 工具代答：requestId="${req.id}"，answer 填你的回答。` +
      `有可选项时从可选项里选一个最合适的作为 answer；无选项时给出简短明确的文字回答。不要替该会话执行具体操作。`
    ctx.supervisorWakeQueue.push(prompt)
    const supMeta = ctx.sessions.get(SUPERVISOR_ID)
    const turnSeq = supMeta ? countNonInjectedUserMessages(supMeta.session) + 1 : 1
    ctx.userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq))
    console.log('[supervisor-wake] 提问请求入队：', req.id, 'queue=', ctx.supervisorWakeQueue.length, 'supervisorWaking=', ctx.supervisorWaking, 'runningLoops.has=', ctx.runningLoops.has(SUPERVISOR_ID))
    void drainSupervisorWake()
  }

  function wakeSupervisorForResult(sid: string, title: string, result?: string, error?: string): void {
    const body = error ? `执行失败：${error}` : (result ?? '（无正文输出）')
    const prompt =
      `【任务回传】会话「${title}」(${sid}) 的任务执行${error ? '失败' : '完成'}。\n` +
      `结果：${body}\n\n` +
      `请按【任务编排】流程接力处理：\n` +
      `1. 若该会话在台账里有任务清单（state.json 的 tasks），ledger({ action: "read" }) 读取后，把刚完成的任务 status 改为 done（失败改 blocked）并回填 result，同步 _index.json。\n` +
      `2. 若清单里还有 status=todo 的后续任务，用 send_message 把下一个任务下发给该会话（继续推进流水线）。\n` +
      `3. 若清单已全部 done、或该会话本就没有任务清单（只是简单转发），更新必要状态后结束本轮，不要重复下发、不要空转。`
    ctx.supervisorWakeQueue.push(prompt)
    const supMeta = ctx.sessions.get(SUPERVISOR_ID)
    const turnSeq = supMeta ? countNonInjectedUserMessages(supMeta.session) + 1 : 1
    ctx.userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq))
    console.log('[supervisor-wake] 任务回传入队：', sid, 'queue=', ctx.supervisorWakeQueue.length, 'supervisorWaking=', ctx.supervisorWaking, 'runningLoops.has=', ctx.runningLoops.has(SUPERVISOR_ID))
    void drainSupervisorWake()
  }

  function wakeSupervisorForClientRun(req: { requestId: string; sessionId: string; pkgId: string; name: string; purpose: string }): void {
    const sid = req.sessionId ?? ''
    const title = sid ? (ctx.sessions.get(sid)?.title ?? sid) : sid
    const prompt =
      `【投递请求】会话「${title}」(${sid}) 请求向界面投递一个插件界面组件（插件 client 半代码）。\n` +
      `动态包：${req.name}（${req.pkgId}）\n` +
      `用途：${req.purpose}\n\n` +
      `请判断是否允许投递，并调用 resolve_client_run 工具决策：requestId="${req.requestId}"，approved 取 true（允许投递）或 false（拒绝投递）。` +
      `这是把插件界面代码投递到界面执行的安全敏感操作，用途可疑请拒绝；不要替该会话执行具体操作。`
    ctx.supervisorWakeQueue.push(prompt)
    const supMeta = ctx.sessions.get(SUPERVISOR_ID)
    const turnSeq = supMeta ? countNonInjectedUserMessages(supMeta.session) + 1 : 1
    ctx.userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq))
    console.log('[supervisor-wake] 投递请求入队：', req.requestId, 'pkg=', req.pkgId, 'queue=', ctx.supervisorWakeQueue.length, 'supervisorWaking=', ctx.supervisorWaking, 'runningLoops.has=', ctx.runningLoops.has(SUPERVISOR_ID))
    void drainSupervisorWake()
  }

  const resend = async (sessionId: string, userMessageIndex: number, newContent?: string): Promise<string> => {
    const meta = ctx.sessions.get(sessionId)
    if (!meta) throw new Error(`会话不存在: ${sessionId}`)
    const events = meta.session.list()
    const effModelId = meta.modelId ?? ctx.defaultModelId
    let userCount = 0
    let targetIdx = -1
    let originalContent = ''
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (e?.type === 'user/message') {
        const d = e.data as { content: string; injected?: boolean }
        if (d.injected) continue
        if (userCount === userMessageIndex) {
          targetIdx = i
          originalContent = d.content
          break
        }
        userCount++
      }
    }
    if (targetIdx < 0) throw new Error(`用户消息不存在: #${userMessageIndex}`)
    const content = newContent !== undefined ? newContent : originalContent
    meta.session.truncate(targetIdx)
    if (sessionId === SUPERVISOR_ID) {
      return runSupervisorInternal(content, undefined, effModelId)
    }
    return runInSession(sessionId, content, undefined, effModelId)
  }

  const resume = async (sessionId: string): Promise<string> => {
    const sid = sessionId
    const meta = ctx.sessions.get(sid)
    if (!meta) throw new Error(`会话不存在: ${sid}`)
    const events = meta.session.list()

    let lastUserIdx = -1
    let lastUserContent = ''
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'user/message') {
        const d = events[i]!.data as { injected?: boolean; content: string }
        if (d.injected) continue
        lastUserIdx = i
        lastUserContent = d.content
        break
      }
    }
    if (lastUserIdx < 0) throw new Error('没有可继续的消息')

    ctx.stoppedSessions.delete(sid)
    sessions.touchSession(sid)
    const isSupervisorRun = sid === SUPERVISOR_ID
    const effModelId = meta.modelId ?? ctx.defaultModelId
    const effModel = modelProvider.resolveProvider(effModelId)
    const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
    const loop = new AgentLoop(
      effModel,
      isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools,
      meta.session,
      ctx.approval,
      sid,
      tokenStats.currentContextBudget(effModelId),
      visionCapable,
      tokenStats.currentApiKey(effModelId),
      modelProvider.resolveCompactModel(),
    )
    ctx.runningLoops.set(sid, loop)
    // 断点续跑前，剔除「最后一个任务」内的孤立 tool/call（有 callId 无配对 tool/result），
    // 避免回放成「assistant 空 content + 无结果 tool」污染续跑上下文；成对 tool/call+tool/result 保留（恢复现场依据）。
    // 普通会话与管家会话一致处理。
    meta.session.removeOrphanToolCalls(lastUserIdx + 1)
    ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, 'start'))
    let suspended = false
    try {
      return await sessionContext.run(sid, () =>
        loop.resumeRun(
          isSupervisorRun ? prompts.buildSupervisorSystemPrompt(lastUserContent) : prompts.buildSystemPrompt(meta.workDir, prompts.buildMemoryContext(lastUserContent, meta.id)),
          (text) => {
            if (ctx.stoppedSessions.has(sid)) throw new Error('__stopped__')
            ctx.deltaCallbacks.forEach((cb) => cb(sid, text))
          },
          (text) => ctx.reasoningCallbacks.forEach((cb) => cb(sid, text)),
        ),
      )
    } catch (err) {
      if (err instanceof Error && err.message === '__stopped__') {
        return '（已中断，历史已保留，可点击「继续执行」续跑）'
      }
      if (err instanceof Error && err.message.startsWith('__retry_exhausted__')) {
        suspended = true
      }
      throw err
    } finally {
      if (!suspended) {
        ctx.runningLoops.delete(sid)
        ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, 'end'))
      }
      meta.lastActiveAt = Date.now()
      await sessions.persistSession(meta)
      tokenStats.emitTokenStats()
      drainSupervisorQueue(sid)
    }
  }

  const retrySession = async (sessionId: string): Promise<string> => {
    const sid = sessionId ?? ctx.currentSessionId
    const meta = ctx.sessions.get(sid)
    if (!meta) throw new Error(`会话不存在: ${sid}`)
    const loop = ctx.runningLoops.get(sid)
    if (loop) {
      try {
        const result = await sessionContext.run(sid, () => loop.retry())
        meta.lastActiveAt = Date.now()
        await sessions.persistSession(meta)
        tokenStats.emitTokenStats()
        return result
      } finally {
        if (!loop.isSuspended()) ctx.runningLoops.delete(sid)
      }
    }
    const snapshot = sessions.readRetrySnapshot(meta)
    if (snapshot) {
      const isSupervisorRun = sid === SUPERVISOR_ID
      const effModelId = meta.modelId ?? ctx.defaultModelId
      const effModel = modelProvider.resolveProvider(effModelId)
      const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId))
      const restoredLoop = new AgentLoop(effModel, isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools, meta.session, ctx.approval, sid, tokenStats.currentContextBudget(effModelId), visionCapable, tokenStats.currentApiKey(effModelId), modelProvider.resolveCompactModel())
      restoredLoop.restoreSuspended(snapshot)
      ctx.runningLoops.set(sid, restoredLoop)
      try {
        const result = await sessionContext.run(sid, () =>
          restoredLoop.retry(
            (text) => {
              if (ctx.stoppedSessions.has(sid)) throw new Error('__stopped__')
              ctx.deltaCallbacks.forEach((cb) => cb(sid, text))
            },
            (text) => ctx.reasoningCallbacks.forEach((cb) => cb(sid, text)),
          ),
        )
        meta.lastActiveAt = Date.now()
        await sessions.persistSession(meta)
        tokenStats.emitTokenStats()
        return result
      } finally {
        if (!restoredLoop.isSuspended()) ctx.runningLoops.delete(sid)
      }
    }
    const events = meta.session.list()
    let lastUserIdx = -1
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'user/message') {
        const d = events[i]!.data as { injected?: boolean }
        if (d.injected) continue
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) throw new Error('没有可继续的消息')
    const content = (events[lastUserIdx]!.data as { content: string }).content
    const effModelId = meta.modelId ?? ctx.defaultModelId
    meta.session.truncate(lastUserIdx)
    if (sid === SUPERVISOR_ID) {
      return runSupervisorInternal(content, undefined, effModelId)
    }
    return runInSession(sid, content, undefined, effModelId)
  }

  const abandonSession = async (sessionId: string): Promise<void> => {
    const sid = sessionId ?? ctx.currentSessionId
    ctx.runningLoops.delete(sid)
    const meta = ctx.sessions.get(sid)
    if (meta) {
      meta.session.removeLast('retry/snapshot')
      await sessions.persistSession(meta)
    }
  }

  const hasRetrySnapshot = (sessionId: string): { reason?: string } | null => {
    const meta = ctx.sessions.get(sessionId)
    if (!meta) return null
    const snap = sessions.readRetrySnapshot(meta)
    return snap ? { reason: snap.reason } : null
  }

  const injectMessage = (sessionId: string, message: string): boolean => {
    const loop = ctx.runningLoops.get(sessionId)
    if (loop) {
      loop.injectUserMessage(message)
      return true
    }
    return false
  }

  const hasIncompleteTurn = (sessionId: string): boolean => {
    if (ctx.runningLoops.has(sessionId)) return false
    const meta = ctx.sessions.get(sessionId)
    if (!meta) return false
    const events = meta.session.list()
    let lastUserIdx = -1
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'user/message') {
        const d = events[i]!.data as { injected?: boolean }
        if (d.injected) continue
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return false
    for (let i = lastUserIdx + 1; i < events.length; i++) {
      const t = events[i]?.type
      if (t === 'assistant/message' || t === 'turn/end') return false
    }
    return true
  }

  /**
   * 发新任务(run)前，物理清理上一个「未完成轮次」的半截事件（普通会话与管家会话一致调用）。
   * 网络中断会在事件日志留下「只有 user、无最终 assistant 正文、无 turn/end 收尾」的半截事件，
   * 污染后续回放/续跑。发新任务即代表放弃对上一个中断任务的断点续跑，故可安全物理删除。
   * 判定：最后一个非 injected 的 user/message 之后没有 assistant/message（最终正文）或 turn/end → 未完成轮次。
   * 清理：truncate 到该 user/message 之前，删掉这条孤立 user + 其后的 turn/start、孤立/成对 tool/call+tool/result
   *       等半截事件；完整轮次（含成对 tool/result、usage/record、model/select 等正常事件）全部保留。
   * 落盘：truncate 会置 Session.requireRewrite=true，persistSession 随后全量重写 events.jsonl 实现物理清理。
   */
  const cleanupIncompleteTurnLog = (meta: SessionMeta): void => {
    const total = meta.session.size
    let lastUserIdx = -1
    for (let i = total - 1; i >= 0; i--) {
      const e = meta.session.at(i)
      if (e?.type === 'user/message') {
        const d = e.data as { injected?: boolean }
        if (d.injected) continue
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return
    // 该 user 之后若有最终 assistant 正文或 turn/end 收尾，说明是完整轮次，无需清理
    for (let i = lastUserIdx + 1; i < total; i++) {
      const t = meta.session.at(i)?.type
      if (t === 'assistant/message' || t === 'turn/end') return
    }
    // 未完成轮次：truncate 删掉 [lastUserIdx, end) 全部半截事件（孤立 user + turn/start + 工具过程）
    meta.session.truncate(lastUserIdx)
  }

  return {
    runInSession,
    dispatchToSession,
    sendMessageToSession,
    runSession,
    notifySupervisorResult,
    drainSupervisorQueue,
    buildSupervisorLoopTools,
    runSupervisorInternal,
    drainSupervisorWake,
    wakeSupervisorForApproval,
    wakeSupervisorForAsk,
    wakeSupervisorForResult,
    wakeSupervisorForClientRun,
    resend,
    resume,
    retrySession,
    abandonSession,
    hasRetrySnapshot,
    injectMessage,
    hasIncompleteTurn,
  }
}
