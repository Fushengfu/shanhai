import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 工具调用上下文：本次工具执行对应的「思考（reasoning）」。
 *
 * agent 层（AgentLoop.handleToolCall）在调用工具前用 run 包住 execute，
 * runtime 层（工具包装器 wrapTool）在执行时 getStore 读出，把它关联到
 * 该次工具调用的 trace 上，前端工具步骤卡片据此折叠展示「这一步在想什么」。
 *
 * 用 AsyncLocalStorage 而非全局变量/Map：并行会话、多专家并行调度下，
 * 每个异步执行上下文天然隔离，不会把某一步的思考错配到另一步。
 */
export const toolReasoningContext = new AsyncLocalStorage<string | undefined>()
