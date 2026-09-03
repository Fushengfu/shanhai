/**
 * sessions 模块：会话 CRUD / 持久化 / 描述 / 历史与痕迹 / 会话级配置 / 切换与停止。
 *
 * 从 bootstrap 拆分：原来 persistSession / createSessionInternal / newSession /
 * ensureSupervisorSession / touchSession / currentWorkDir / describeSession /
 * setSessionModelInternal / renameSessionInternal / deleteSessionInternal /
 * switchSessionInternal / stopSessionInternal / getSessionHistory / getSessionTrace /
 * getHistory 及 sessionApprovalPolicy 都是 bootstrap 的闭包。
 * 现在收敛为 createSessionsModule(ctx, deps)。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Session, type ApprovalPolicy, type SessionEvent } from '@shanhai/session'
import type { SuspendedSnapshot } from '@shanhai/agent'
import type { ChatMessage } from '@shanhai/llm'
import type { GatewayModel } from '@shanhai/auth'
import {
  sessionDirPath,
  writeSessionMetaFile,
  appendSessionEventsFile,
  rewriteSessionEventsFile,
  appendAuditEventsFile,
  rewriteAuditEventsFile,
  deleteSessionDir,
} from './session-store'
import { persistLastActiveSessionId } from './config'
import { ensureSupervisorWorkspace, removeSessionLedger, SUPERVISOR_WORKSPACE } from './supervisor-workspace'
import { SUPERVISOR_ID, type SessionStateSummary } from './supervisor'
import { DEFAULT_WORK_DIR, type RuntimeContext, type SessionMeta } from './context'
import type { TokenStatsModule } from './token-stats'
import type { ModelProviderModule } from './model-provider'
import type { DeepSeekBridgeModule } from './deepseek-bridge'
import type { ToolTrace } from './types'

export interface SessionsModule {
  persistSession(meta: SessionMeta): Promise<void>
  readRetrySnapshot(meta: SessionMeta): SuspendedSnapshot | null
  createSessionInternal(title?: string, workDir?: string): string
  newSession(title: string, workDir?: string): string
  ensureSupervisorSession(): void
  touchSession(id: string): void
  currentWorkDir(): string
  sessionApprovalPolicy(sid?: string): ApprovalPolicy
  describeSession(sid: string): SessionStateSummary | null
  setSessionModelInternal(sid: string, modelId: string): { ok: boolean; message: string }
  setSessionApprovalInternal(sid: string, policy: ApprovalPolicy): { ok: boolean; message: string }
  renameSessionInternal(sid: string, title: string): { ok: boolean; message: string }
  setSessionWorkdirInternal(sid: string, workdir: string): { ok: boolean; message: string }
  deleteSessionInternal(sid: string): Promise<{ ok: boolean; message: string }>
  getSupervisorModelInternal(): string
  getSupervisorApprovalInternal(): ApprovalPolicy
  setSupervisorModelInternal(modelId: string): { ok: boolean; message: string }
  setSupervisorApprovalInternal(policy: ApprovalPolicy): { ok: boolean; message: string }
  switchSessionInternal(id: string): { ok: boolean; message: string }
  stopSessionInternal(sid: string): void
  getSessionHistory(id?: string): Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[]; turnSeq?: number; turnDuration?: number }>
  getSessionTrace(id?: string): Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoningContent?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>; toolCallId?: string; toolName?: string; result?: unknown; error?: string; turn: number; timestamp: number }>
  getHistory(): Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }>
}

export function createSessionsModule(
  ctx: RuntimeContext,
  deps: {
    getTokenStats: () => TokenStatsModule
    getModelProvider: () => ModelProviderModule
    getDeepSeekBridge: () => DeepSeekBridgeModule
    allModels: () => GatewayModel[]
  },
): SessionsModule {
  const { getTokenStats, getModelProvider, getDeepSeekBridge, allModels } = deps

  // 内核事件总线安全发射：host 半插件经 ctx.on 订阅内核事件（session:created / message / model:switched 等）。
  // 单个插件监听器抛异常不能中断会话编排主流程，故 try-catch 吞掉（异常只影响该插件自己）。
  const safeEmit = (name: string, payload: unknown): void => {
    try {
      ctx.kernel.ctx.emit(name, payload)
    } catch {
      // ignore：插件监听器异常不影响会话创建/模型切换/消息编排
    }
  }

  async function persistSessionInner(meta: SessionMeta): Promise<void> {
    try {
      const dir = sessionDirPath(ctx.sessionsDir, meta.id)
      // 1. meta 小文件覆盖写（原子：临时文件 + rename）
      await writeSessionMetaFile(dir, {
        id: meta.id,
        title: meta.title,
        workDir: meta.workDir,
        lastActiveAt: meta.lastActiveAt,
        modelId: meta.modelId,
        approvalPolicy: meta.approvalPolicy,
      })
      // 2. events 增量追加（或截断/删除历史后全量重写）
      const session = meta.session
      // 事件分流：assistant/delta 丢弃（流式增量中间态，最终 assistant/message 已含完整内容）；
      // assistant/raw（模型输出带系统保留标签的原始完整输出）进独立审计文件 tagged-outputs.jsonl，不写 events.jsonl（保证主日志不含系统保留标签）。
      const partition = (events: SessionEvent[]) => {
        const raw: SessionEvent[] = []
        const durable: SessionEvent[] = []
        for (const e of events) {
          if (e.type === 'assistant/delta') continue
          if (e.type === 'assistant/raw') raw.push(e)
          else durable.push(e)
        }
        return { raw, durable }
      }
      if (session.requireRewrite()) {
        const { raw, durable } = partition(session.list())
        await rewriteSessionEventsFile(dir, durable)
        await rewriteAuditEventsFile(dir, raw)
        session.markPersisted()
      } else {
        const { raw, durable } = partition(session.slice(session.persistedCount))
        if (durable.length > 0) {
          await appendSessionEventsFile(dir, durable)
        }
        if (raw.length > 0) {
          await appendAuditEventsFile(dir, raw)
        }
        session.persistedCount = session.size
      }
    } catch {
      // 忽略持久化失败
    }
  }

  const persistSession = (meta: SessionMeta): Promise<void> => {
    const prev = ctx.sessionWriteChains.get(meta.id) ?? Promise.resolve()
    const next = prev.then(() => persistSessionInner(meta)).catch(() => undefined)
    ctx.sessionWriteChains.set(meta.id, next)
    return next
  }

  const readRetrySnapshot = (meta: SessionMeta): SuspendedSnapshot | null => {
    const events = meta.session.list()
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'turn/end') break
      if (e?.type === 'retry/snapshot') {
        const d = e.data as { messages: unknown[]; step: number; maxSteps: number; atLimit: boolean; reason?: string }
        return {
          messages: d.messages as ChatMessage[],
          step: d.step,
          maxSteps: d.maxSteps,
          atLimit: d.atLimit,
          reason: d.reason,
        }
      }
    }
    return null
  }

  const createSessionInternal = (title?: string, workDir?: string): string => {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const meta: SessionMeta = { id, title: title?.trim() || '新会话', session: new Session(), workDir: workDir ?? DEFAULT_WORK_DIR, lastActiveAt: Date.now(), isSupervisor: false }
    ctx.sessions.set(id, meta)
    void persistSession(meta)
    safeEmit('session:created', { sessionId: id, title: meta.title, isSupervisor: false })
    return id
  }

  const newSession = (title: string, workDir?: string): string => {
    const id = createSessionInternal(title, workDir)
    ctx.currentSessionId = id
    void persistLastActiveSessionId(id)
    return id
  }

  const ensureSupervisorSession = (): void => {
    void ensureSupervisorWorkspace()
    if (ctx.sessions.has(SUPERVISOR_ID)) return
    const meta: SessionMeta = {
      id: SUPERVISOR_ID,
      title: '会话管家',
      session: new Session(),
      workDir: SUPERVISOR_WORKSPACE,
      lastActiveAt: Date.now(),
      isSupervisor: true,
    }
    ctx.sessions.set(SUPERVISOR_ID, meta)
    void persistSession(meta)
    safeEmit('session:created', { sessionId: SUPERVISOR_ID, title: '会话管家', isSupervisor: true })
  }

  const touchSession = (id: string): void => {
    const meta = ctx.sessions.get(id)
    if (meta) {
      meta.lastActiveAt = Date.now()
      void persistSession(meta)
    }
  }

  const currentWorkDir = (): string => {
    const meta = ctx.currentSessionId ? ctx.sessions.get(ctx.currentSessionId) : undefined
    return meta?.workDir ?? DEFAULT_WORK_DIR
  }

  const sessionApprovalPolicy = (sid?: string): ApprovalPolicy => {
    const meta = ctx.sessions.get(sid ?? ctx.currentSessionId ?? '')
    if (!meta) return 'ask'
    return meta.approvalPolicy ?? 'ask'
  }

  const describeSession = (sid: string): SessionStateSummary | null => {
    const meta = ctx.sessions.get(sid)
    if (!meta || meta.isSupervisor) return null
    const events = meta.session.list()
    let currentRequest = ''
    let lastUserIdx = -1
    const userRequests: string[] = []
    for (const e of events) {
      if (e?.type === 'user/message') {
        const d = e.data as { content?: string; injected?: boolean }
        if (!d.injected) {
          const text = (d.content ?? '').trim()
          if (text) userRequests.push(text)
        }
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'user/message') {
        const d = e.data as { content?: string; injected?: boolean }
        if (!d.injected) {
          currentRequest = d.content ?? ''
          lastUserIdx = i
          break
        }
      }
    }
    const recentRequests = userRequests.slice(-3).map((t) => (t.length > 120 ? t.slice(0, 120) + '…' : t))
    let turnStartIdx = -1
    for (let i = 0; i < events.length; i++) {
      if (events[i]?.type === 'turn/start') turnStartIdx = i
    }
    let stepCount = 0
    for (let i = turnStartIdx + 1; i < events.length; i++) {
      if (events[i]?.type === 'tool/call') stepCount++
    }
    let hasIncompleteTurn = false
    if (!ctx.runningLoops.has(sid) && lastUserIdx >= 0) {
      let done = false
      for (let i = lastUserIdx + 1; i < events.length; i++) {
        const t = events[i]?.type
        if (t === 'assistant/message' || t === 'turn/end') {
          done = true
          break
        }
      }
      hasIncompleteTurn = !done
    }
    let hasRetrySnapshot = false
    for (let i = events.length - 1; i >= 0; i--) {
      const t = events[i]?.type
      if (t === 'turn/end') break
      if (t === 'retry/snapshot') {
        hasRetrySnapshot = true
        break
      }
    }
    const modelId = meta.modelId ?? ctx.defaultModelId
    const modelDef = allModels().find((m) => m.id === modelId)
    const snap = getTokenStats().snapshot(sid)
    return {
      id: meta.id,
      title: meta.title,
      workDir: meta.workDir,
      busy: ctx.runningLoops.has(sid),
      active: ctx.currentSessionId === sid,
      modelId,
      modelName: modelDef?.displayName ?? modelDef?.name ?? modelId,
      approvalPolicy: meta.approvalPolicy ?? 'ask',
      currentRequest,
      recentRequests,
      stepCount,
      contextLength: snap.contextLength,
      lastPrompt: snap.lastPrompt,
      contextUsageRatio: snap.contextUsageRatio,
      turnCount: snap.turnCount,
      hasIncompleteTurn,
      hasRetrySnapshot,
      lastActiveAt: meta.lastActiveAt,
    }
  }

  const setSessionModelInternal = (sid: string, modelId: string): { ok: boolean; message: string } => {
    const meta = ctx.sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    if (!allModels().some((m) => m.id === modelId)) return { ok: false, message: `模型不存在: ${modelId}（用 list_models 查看可用模型）` }
    meta.modelId = modelId
    void persistSession(meta)
    if (ctx.currentSessionId === sid) getModelProvider().applyModel(modelId)
    safeEmit('model:switched', { sessionId: sid, modelId })
    return { ok: true, message: `已将会话「${meta.title}」(${sid}) 的模型切换为 ${modelId}` }
  }

  const setSessionApprovalInternal = (sid: string, policy: ApprovalPolicy): { ok: boolean; message: string } => {
    const meta = ctx.sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    meta.approvalPolicy = policy
    // 会话级安全模式写入事件日志（approval/policy）：审批判断 effectiveApprovalPolicy 从事件日志回放，
    // 只改 meta.approvalPolicy 会让管家 set_session_approval 设置的值不生效（回退全局 policy）。
    meta.session.append('approval/policy', { policy })
    void persistSession(meta)
    if (ctx.currentSessionId === sid) ctx.approval.setPolicy(policy)
    return { ok: true, message: `已将会话「${meta.title}」(${sid}) 的安全模式设为 ${policy}` }
  }

  const renameSessionInternal = (sid: string, title: string): { ok: boolean; message: string } => {
    const meta = ctx.sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    const trimmed = title.trim()
    if (!trimmed) return { ok: false, message: '会话标题不能为空' }
    meta.title = trimmed
    void persistSession(meta)
    return { ok: true, message: `已将会话重命名为「${trimmed}」(${sid})` }
  }

  const setSessionWorkdirInternal = (sid: string, workdir: string): { ok: boolean; message: string } => {
    const meta = ctx.sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    const trimmed = workdir.trim()
    if (!trimmed) return { ok: false, message: '工作目录不能为空' }
    meta.workDir = trimmed
    void persistSession(meta)
    return { ok: true, message: `已将会话「${meta.title}」(${sid}) 的工作目录设为 ${trimmed}` }
  }

  const deleteSessionInternal = async (sid: string): Promise<{ ok: boolean; message: string }> => {
    const meta = ctx.sessions.get(sid)
    if (!meta || meta.isSupervisor) return { ok: false, message: `会话不存在: ${sid}` }
    const title = meta.title
    for (const [requestId, p] of ctx.pendingApprovals) {
      if (p.sessionId === sid) {
        p.resolve('rejected')
        ctx.pendingApprovals.delete(requestId)
      }
    }
    for (const [requestId, p] of ctx.pendingClientRuns) {
      if (p.sessionId === sid) {
        p.resolve(false)
        ctx.pendingClientRuns.delete(requestId)
      }
    }
    ctx.askService.cancelSession(sid)
    // 等待该会话的持久化写入队列清空（否则删除目录后 pending 写入会重新创建 meta.json，导致 ENOTEMPTY）
    const pendingWrite = ctx.sessionWriteChains.get(sid)
    if (pendingWrite) await pendingWrite.catch(() => undefined)
    ctx.sessionWriteChains.delete(sid)
    ctx.sessions.delete(sid)
    await deleteSessionDir(sessionDirPath(ctx.sessionsDir, sid))
    await fs.rm(join(ctx.sessionsDir, `${sid}.json`), { force: true }).catch(() => undefined)
    await fs.rm(ctx.httpTrace.path(sid), { force: true }).catch(() => undefined)
    await removeSessionLedger(sid)
    if (ctx.currentSessionId === sid) {
      const next = [...ctx.sessions.values()].find((s) => !s.isSupervisor)
      if (next) {
        ctx.currentSessionId = next.id
        ctx.sessionRef = next.session
        void persistLastActiveSessionId(next.id)
      } else {
        newSession('新会话')
      }
    }
    return { ok: true, message: `已删除会话「${title}」(${sid})` }
  }

  const getSupervisorModelInternal = (): string => {
    const meta = ctx.sessions.get(SUPERVISOR_ID)
    return meta?.modelId ?? ctx.defaultModelId
  }

  const getSupervisorApprovalInternal = (): ApprovalPolicy => sessionApprovalPolicy(SUPERVISOR_ID)

  const setSupervisorModelInternal = (modelId: string): { ok: boolean; message: string } => {
    const meta = ctx.sessions.get(SUPERVISOR_ID)
    if (!meta) return { ok: false, message: '管家会话不存在' }
    if (!allModels().some((m) => m.id === modelId)) return { ok: false, message: `模型不存在: ${modelId}（用 list_models 查看可用模型）` }
    meta.modelId = modelId
    void persistSession(meta)
    return { ok: true, message: `管家模型已切换为 ${modelId}` }
  }

  const setSupervisorApprovalInternal = (policy: ApprovalPolicy): { ok: boolean; message: string } => {
    const meta = ctx.sessions.get(SUPERVISOR_ID)
    if (!meta) return { ok: false, message: '管家会话不存在' }
    meta.approvalPolicy = policy
    // 会话级安全模式写入事件日志（approval/policy）：审批判断 effectiveApprovalPolicy 从事件日志回放。
    meta.session.append('approval/policy', { policy })
    void persistSession(meta)
    return { ok: true, message: `管家安全模式已设为 ${policy}` }
  }

  const switchSessionInternal = (id: string): { ok: boolean; message: string } => {
    const target = ctx.sessions.get(id)
    if (!target || target.isSupervisor) return { ok: false, message: `会话不存在: ${id}` }
    ctx.currentSessionId = id
    ctx.sessionRef = target.session
    void persistLastActiveSessionId(id)
    ctx.approval.setPolicy(target.approvalPolicy ?? 'ask')
    const sidModel = target.modelId
    if (sidModel) {
      getModelProvider().applyModel(sidModel)
    } else if (ctx.defaultModelId) {
      getModelProvider().applyModel(ctx.defaultModelId)
    }
    getTokenStats().emitTokenStats(id)
    getDeepSeekBridge().ensureDefaultBrowserWindow(id)
    ctx.currentSessionChangedCallbacks.forEach((cb) => cb(id))
    return { ok: true, message: `已激活会话「${target.title}」(${id})` }
  }

  const stopSessionInternal = (sid: string): void => {
    if (!sid) return
    ctx.stoppedSessions.add(sid)
    ctx.runningLoops.get(sid)?.abort()
    for (const [requestId, p] of ctx.pendingApprovals) {
      if (p.sessionId === sid) {
        p.resolve('rejected')
        ctx.pendingApprovals.delete(requestId)
      }
    }
    for (const [requestId, p] of ctx.pendingClientRuns) {
      if (p.sessionId === sid) {
        p.resolve(false)
        ctx.pendingClientRuns.delete(requestId)
      }
    }
  }

  const getSessionHistory = (id?: string) => {
    const target = ctx.sessions.get(id ?? ctx.currentSessionId ?? '')
    if (!target) return []
    const out: Array<{ kind: 'user' | 'assistant' | 'tool'; content?: string; reasoningContent?: string; trace?: ToolTrace; attachments?: unknown[]; turnSeq?: number; turnDuration?: number }> = []
    let userSeq = 0
    let turnStartTs = 0
    const toolStartMap = new Map<string, number>()
    const eventCount = target.session.size
    for (let i = 0; i < eventCount; i++) {
      const e = target.session.at(i)
      if (!e) continue
      if (e.type === 'user/message') {
        const d = e.data as { content: string; attachments?: unknown[]; injected?: boolean }
        if (d.injected) continue
        userSeq += 1
        turnStartTs = e.timestamp
        out.push({ kind: 'user', content: d.content, attachments: d.attachments, turnSeq: userSeq })
      } else if (e.type === 'assistant/message') {
        const d = e.data as { content: string; reasoningContent?: string }
        const turnDuration = turnStartTs > 0 ? e.timestamp - turnStartTs : undefined
        out.push({ kind: 'assistant', content: d.content, reasoningContent: d.reasoningContent, turnSeq: userSeq, turnDuration })
      } else if (e.type === 'tool/call') {
        const d = e.data as { callId: string; name: string; args: Record<string, unknown>; reasoningContent?: string }
        toolStartMap.set(d.callId, e.timestamp)
        out.push({ kind: 'tool', trace: { kind: 'tool-call', sessionId: target.id, callId: d.callId, name: d.name, args: d.args, reasoning: d.reasoningContent, startTs: e.timestamp } })
      } else if (e.type === 'tool/result') {
        const d = e.data as { callId: string; name: string; result?: unknown; error?: string }
        const startTs = toolStartMap.get(d.callId)
        const durationMs = startTs != null && startTs > 0 ? e.timestamp - startTs : undefined
        out.push({ kind: 'tool', trace: { kind: 'tool-result', sessionId: target.id, callId: d.callId, name: d.name, result: d.result, error: d.error, durationMs } })
      }
    }
    return out
  }

  const getSessionTrace = (id?: string) => {
    const target = ctx.sessions.get(id ?? ctx.currentSessionId ?? '')
    if (!target) return []
    const out: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoningContent?: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>; toolCallId?: string; toolName?: string; result?: unknown; error?: string; turn: number; timestamp: number }> = []
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
        out.push({ role: 'tool', content: text, toolCallId: d.callId, toolName: d.name, result: d.result, error: d.error, turn, timestamp: e.timestamp })
      }
    }
    return out
  }

  const getHistory = () => {
    const target = ctx.sessions.get(ctx.currentSessionId ?? '')
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
  }

  return {
    persistSession,
    readRetrySnapshot,
    createSessionInternal,
    newSession,
    ensureSupervisorSession,
    touchSession,
    currentWorkDir,
    sessionApprovalPolicy,
    describeSession,
    setSessionModelInternal,
    setSessionApprovalInternal,
    renameSessionInternal,
    setSessionWorkdirInternal,
    deleteSessionInternal,
    getSupervisorModelInternal,
    getSupervisorApprovalInternal,
    setSupervisorModelInternal,
    setSupervisorApprovalInternal,
    switchSessionInternal,
    stopSessionInternal,
    getSessionHistory,
    getSessionTrace,
    getHistory,
  }
}
