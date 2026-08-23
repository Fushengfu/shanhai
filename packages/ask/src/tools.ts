import type { ToolContract } from '@shanhai/tools'
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
      'question 是要向用户提出的问题；options 是可选答案列表（提供则用户单选，multiple 为 true 时多选）；' +
      '不提供 options 则用户自由输入文字。placeholder 是自由输入时的提示语。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要向用户提出的问题（必填）' },
        options: { type: 'array', items: { type: 'string' }, description: '可选答案列表（单选；配合 multiple 可多选）' },
        multiple: { type: 'boolean', description: '是否多选（默认 false 单选，仅 options 提供时生效）' },
        placeholder: { type: 'string', description: '自由文本输入时的占位提示' },
      },
      required: ['question'],
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const question = String(args.question ?? '').trim()
      if (!question) return { ok: false, error: 'question 不能为空' }
      const options = Array.isArray(args.options) ? args.options.map((o) => String(o)).filter(Boolean) : undefined
      const multiple = args.multiple === true
      const placeholder = args.placeholder ? String(args.placeholder) : undefined
      const answer = await service.ask(question, {
        options: options && options.length > 0 ? options : undefined,
        multiple,
        placeholder,
        sessionId: getSessionId(),
      })
      // 用户取消回答/选择（或会话被删除导致提问被取消）时，返回错误而非把取消标记当答案回喂模型
      if (answer === ASK_CANCELLED) return { ok: false, error: '用户取消了回答' }
      return answer
    },
  }
}
