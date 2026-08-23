/**
 * DeepSeek 网页版 → 模型 provider（CDP 直连，无本地 HTTP 服务）。
 *
 * 把已登录的 DeepSeek 网页版（chat.deepseek.com）封装成一个实现 @shanhai/llm `Model`
 * 接口的 provider：上层 agent 像调用普通模型一样调它的 complete()，内部跑自包含 ReAct
 * （用网页版模型输出 <tool_calls> 标签 → 执行内置工具 → 回填 → 循环，直到输出 <content>）。
 *
 * 与网页版的通信由宿主注入的 chat 回调完成（CDP 直连页面 window.__dsChat，不再走本地
 * 端口/任务队列）。工作目录通过 getWorkspace 回调随会话切换更新，内置工具路径强制限制
 * 在工作目录内（safeResolve 防路径穿越）。
 *
 * 消费完工具调用后只返回最终 content（不返回 tool_calls），避免上层 agent 把内部工具
 * 调用误当成自己的工具循环。
 */
import type { Model } from '@shanhai/llm'
import { createBuiltinTools } from './tools'
import { runAgent, type BridgeMessage } from './react'

/** 发送一条 prompt 给 DeepSeek 网页版并返回 AI 原始回复（宿主经 CDP 直连页面 window.__dsChat 实现） */
export type DeepSeekChatFn = (prompt: string, opts: { mode: string; thinking: boolean }) => Promise<string>

/** createDeepSeekModel 的构造参数 */
export interface DeepSeekModelOptions {
  /** 与 DeepSeek 网页版对话的通道（CDP 直连页面桥接脚本） */
  chat: DeepSeekChatFn
  /** 返回当前会话工作目录（内置工具路径限制在此目录内，随会话切换更新） */
  getWorkspace: () => string
  /** ReAct 最大轮数（默认 1000） */
  maxSteps?: number
  /** 会话模式（默认 expert；可选 fast / vision） */
  mode?: 'expert' | 'fast' | 'vision'
  /** 深度思考开关（默认开启） */
  thinking?: boolean
}

/**
 * 创建「DeepSeek 网页版」模型 provider（实现 @shanhai/llm Model 接口）。
 * 自包含 ReAct：内部工具调用已消费，complete 只返回最终内容 + 思考过程。
 */
export function createDeepSeekModel(opts: DeepSeekModelOptions): Model {
  const tools = createBuiltinTools(opts.getWorkspace)
  const maxSteps = opts.maxSteps ?? 1000
  const mode = opts.mode ?? 'expert'
  const thinking = opts.thinking ?? true

  return {
    async complete(messages) {
      const result = await runAgent(messages as BridgeMessage[], {
        tools,
        maxSteps,
        mode,
        thinking,
        chat: opts.chat,
      })
      return { text: result.content, reasoningContent: result.reasoningContent || undefined }
    },
  }
}
