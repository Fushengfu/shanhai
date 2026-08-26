/**
 * token 统计模块：累计 / 本轮 / 上下文占比（UI 底部状态栏展示，会话级隔离）。
 *
 * 从 bootstrap 拆分：原来 sessionStats / countCompletedTurns / snapshot / emitTokenStats /
 * onUsage / onHttpTrace / refreshContextLength / currentContextBudget / currentApiKey 都是
 * bootstrap 的闭包，互相调用且共享 tokenStats / tokenCallbacks / sessions 等状态。
 * 现在收敛为 createTokenStatsModule(ctx, allModels, getCurrentSid)。
 */
import type { TokenUsage, HttpTrace } from '@shanhai/llm'
import type { GatewayModel } from '@shanhai/auth'
import type { RuntimeContext, TokenAccumulator } from './context'
import type { TokenSnapshot } from './types'
import { SUPERVISOR_ID } from './supervisor'

/** 网关默认给 completion（max_tokens）预留的空间（token 数）。客户端未传 max_tokens 时，网关侧默认 64K。
 * 用于把 contextLength 折算成「messages 实际可用窗口」，避免用完整 contextLength 判断导致 messages 估算“够用”却因预留 completion 超限打 400。 */
const DEFAULT_COMPLETION_RESERVE = 65536

export interface TokenStatsModule {
  /** 获取（或初始化）指定会话的 token 累计器（累计值从事件日志 usage/record 恢复，重启不归零） */
  sessionStats(sid: string): TokenAccumulator
  /** 指定会话累计完成的任务循环轮次 */
  countCompletedTurns(sid?: string): number
  /** 指定会话（缺省当前）的 token 用量快照 */
  snapshot(sid?: string): TokenSnapshot
  /** 广播 token 用量变化 */
  emitTokenStats(sid?: string): void
  /** 每次模型返回 usage 时累计（流式末尾 / 一次性 complete 均触发），按发起会话隔离 */
  onUsage(usage: TokenUsage): void
  /** 每次模型 HTTP 调用回传原始请求/响应（排查问题用），写会话隔离的日志文件 */
  onHttpTrace(trace: HttpTrace): void
  /** 刷新当前模型的上下文窗口长度（模型切换/登录后调用），写入当前会话 */
  refreshContextLength(): void
  /** 当前模型的上下文窗口大小（token 数），压缩触发阈值在 AgentLoop 内按窗口 60% 计算 */
  currentContextBudget(modelId?: string): number | undefined
  /** 当前模型的 apiKey（user_id 确定性派生用） */
  currentApiKey(modelId?: string): string
}

export function createTokenStatsModule(
  ctx: RuntimeContext,
  allModels: () => GatewayModel[],
  getCurrentSid: () => string,
): TokenStatsModule {
  const sessionStats = (sid: string): TokenAccumulator => {
    let s = ctx.tokenStats.get(sid)
    if (!s) {
      s = { totalPrompt: 0, totalCompletion: 0, total: 0, turnPrompt: 0, turnCompletion: 0, turn: 0, contextLength: 0, lastPrompt: 0, lastCachedPromptTokens: 0, turnCachedPromptTokens: 0, totalCachedPromptTokens: 0 }
      // 持久化恢复：usage/record 已随事件日志落盘，遍历累加恢复——
      // 1) 累计值（总入/总出/总 token/累计缓存命中）：累加全部 usage/record；
      // 2) 最近一次（lastPrompt/lastCachedPromptTokens）：取最后一条 usage/record，恢复缓存命中率与上下文占比；
      // 3) 本轮（turnPrompt/turnCompletion/turn/turnCachedPromptTokens）：取最后一个 turn/start 之后的 usage/record 累加，恢复本轮输入输出。
      const meta = ctx.sessions.get(sid)
      if (meta) {
        const events = meta.session.list()
        // 最后一个 turn/start 的下标作为「本轮」起点（之前轮次的 usage 不计入本轮）
        let turnStartIdx = -1
        for (let i = 0; i < events.length; i++) {
          if (events[i]?.type === 'turn/start') turnStartIdx = i
        }
        let lastUsage: { promptTokens?: number; cachedPromptTokens?: number } | null = null
        let turnPrompt = 0
        let turnCompletion = 0
        let turn = 0
        let turnCached = 0
        for (let i = 0; i < events.length; i++) {
          const e = events[i]
          if (e?.type !== 'usage/record') continue
          const d = e.data as { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedPromptTokens?: number }
          s.totalPrompt += d.promptTokens ?? 0
          s.totalCompletion += d.completionTokens ?? 0
          s.total += d.totalTokens ?? 0
          s.totalCachedPromptTokens += d.cachedPromptTokens ?? 0
          lastUsage = d
          if (i > turnStartIdx) {
            turnPrompt += d.promptTokens ?? 0
            turnCompletion += d.completionTokens ?? 0
            turn += d.totalTokens ?? 0
            turnCached += d.cachedPromptTokens ?? 0
          }
        }
        s.turnPrompt = turnPrompt
        s.turnCompletion = turnCompletion
        s.turn = turn
        s.turnCachedPromptTokens = turnCached
        if (lastUsage) {
          s.lastPrompt = lastUsage.promptTokens ?? 0
          s.lastCachedPromptTokens = lastUsage.cachedPromptTokens ?? 0
        }
      }
      ctx.tokenStats.set(sid, s)
    }
    return s
  }

  const countCompletedTurns = (sid?: string): number => {
    const meta = ctx.sessions.get(sid ?? ctx.currentSessionId ?? '')
    if (!meta) return 0
    return meta.session.list().filter((e) => e.type === 'turn/end').length
  }

  const snapshot = (sid?: string): TokenSnapshot => {
    const target = sid ?? ctx.currentSessionId ?? ''
    const s = sessionStats(target)
    // contextLength 兜底：supervisor 会话用管家模型（meta.modelId），其余用全局当前模型
    const fallbackModelId = target === SUPERVISOR_ID
      ? (ctx.sessions.get(SUPERVISOR_ID)?.modelId ?? ctx.defaultModelId)
      : ctx.currentModelId
    const ctxLen = s.contextLength > 0 ? s.contextLength : allModels().find((m) => m.id === fallbackModelId)?.contextLength ?? 0
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
      cacheHitRatio: s.lastPrompt > 0 ? s.lastCachedPromptTokens / s.lastPrompt : 0,
      turnCount: countCompletedTurns(target),
    }
  }

  const emitTokenStats = (sid?: string): void => {
    const target = sid ?? ctx.currentSessionId ?? ''
    const s = snapshot(target)
    ctx.tokenCallbacks.forEach((cb) => cb(target, s))
  }

  const onUsage = (usage: TokenUsage): void => {
    const sid = getCurrentSid()
    const s = sessionStats(sid)
    const cached = usage.cachedPromptTokens ?? 0
    s.totalPrompt += usage.promptTokens
    s.totalCompletion += usage.completionTokens
    s.total += usage.totalTokens
    s.turnPrompt += usage.promptTokens
    s.turnCompletion += usage.completionTokens
    s.turn += usage.totalTokens
    s.lastPrompt = usage.promptTokens
    s.lastCachedPromptTokens = cached
    s.turnCachedPromptTokens += cached
    s.totalCachedPromptTokens += cached
    emitTokenStats(sid)
  }

  const onHttpTrace = (trace: HttpTrace): void => {
    if (!ctx.currentSettings.debug.traceLlm) return
    const sid = getCurrentSid()
    if (!sid) return
    void ctx.httpTrace.append(sid, trace)
  }

  const refreshContextLength = (): void => {
    const m = allModels().find((m) => m.id === ctx.currentModelId)
    const s = sessionStats(ctx.currentSessionId ?? '')
    s.contextLength = m?.contextLength ?? 0
    emitTokenStats()
  }

  const currentContextBudget = (modelId?: string): number | undefined => {
    const m = allModels().find((x) => x.id === (modelId ?? ctx.currentModelId))
    if (m?.contextLength && m.contextLength > 0) {
      // 预留 completion 空间：模型配置显式下发 maxTokens 则用它，否则按网关默认 64K。
      // 否则把完整 contextLength 当 budget，会导致发起时裁剪/压缩判断“没超窗口”，实际却因预留 completion 超限打 400。
      const reserved = m.maxTokens && m.maxTokens > 0 ? m.maxTokens : DEFAULT_COMPLETION_RESERVE
      return Math.max(m.contextLength - reserved, 1)
    }
    return undefined
  }

  const currentApiKey = (modelId?: string): string => allModels().find((x) => x.id === (modelId ?? ctx.currentModelId))?.apiKey ?? ctx.gatewayApiKey ?? ''

  return { sessionStats, countCompletedTurns, snapshot, emitTokenStats, onUsage, onHttpTrace, refreshContextLength, currentContextBudget, currentApiKey }
}
