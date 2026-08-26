import { toolReasoningContext, type ToolContract } from '@shanhai/tools'
import { ASK_CANCELLED, type AskService } from './ask'

/**
 * ask 插件：把「向用户提问」收敛为 ask_user 工具。
 * agent 需要用户协助做选择/补充信息时调用，阻塞等待用户回答后继续执行。
 *
 * 复用审批的「阻塞等待 + UI 卡片」链路：execute 挂起（AskService.ask），UI 弹交互式卡片，
 * 用户提交后 resolve，答案作为工具结果回喂给模型继续执行。
 */
export function createAskTools(service: AskService, getSessionId: () => string): ToolContract[] {
  return [askUserTool(service, getSessionId)]
}

function askUserTool(service: AskService, getSessionId: () => string): ToolContract {
  return {
    name: 'ask_user',
    description:
      '当需要用户协助做选择、确认或补充信息时调用，向用户提问并等待回答，然后基于回答继续执行。' +
      'question 必须自包含地写清楚：① 当前正在做什么/背景是什么 ② 为什么需要用户来做这个决定 ③ 具体要用户选/回答什么；' +
      '禁止只写一句「请选择」「怎么处理」这类空话，让用户不看上下文也能理解在问什么。' +
      'options 是可选答案列表（提供则用户单选，multiple 为 true 时多选），每一项必须写清楚「是什么 + 选它意味着什么/后果」，禁止只写孤零零的名词；' +
      '不提供 options 则用户自由输入文字。placeholder 是自由输入时的提示语。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要向用户提出的问题（必填）。必须自包含地写清楚背景、为什么需要用户决定、以及具体要用户选什么，不能让用户靠记忆猜' },
        options: { type: 'array', items: { type: 'string' }, description: '可选答案列表（单选；配合 multiple 可多选）。每一项写清楚「是什么 + 选它的后果」，禁止只写名词' },
        multiple: { type: 'boolean', description: '是否多选（默认 false 单选，仅 options 提供时生效）' },
        placeholder: { type: 'string', description: '自由文本输入时的占位提示' },
      },
      required: ['question'],
    },
    riskLevel: 'readonly',
    // 等用户回答：不设超时（用户思考/离开多久由用户决定，不该被 5 分钟统一兜底打断）
    timeoutMs: Infinity,
    execute: async (args) => {
      const question = String(args.question ?? '').trim()
      if (!question) return { ok: false, error: 'question 不能为空' }
      const options = Array.isArray(args.options) ? args.options.map((o) => String(o)).filter(Boolean) : undefined
      const multiple = args.multiple === true
      const placeholder = args.placeholder ? String(args.placeholder) : undefined
      // 把 AI 本次调用工具的「思考过程」一并带给 UI，供提问卡片折叠展示「AI 为什么问你」的背景
      const answer = await service.ask(question, {
        options: options && options.length > 0 ? options : undefined,
        multiple,
        placeholder,
        sessionId: getSessionId(),
        reasoning: toolReasoningContext.getStore(),
      })
      // 用户取消回答/选择（或会话被删除导致提问被取消）时，返回错误而非把取消标记当答案回喂模型
      if (answer === ASK_CANCELLED) return { ok: false, error: '用户取消了回答' }
      return answer
    },
  }
}
