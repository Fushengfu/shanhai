import type { ModelTier } from '@shanhai/auth'
import type { GatewayModel } from '@shanhai/auth'
import type { ChatMessage, ModelResponse, StreamChunk } from '@shanhai/llm'
import { DeepSeekProvider } from '@shanhai/llm'
import type { ToolContract } from '@shanhai/tools'

export interface LlmGateway {
  /** 按层级解析可用模型：override > 同层 > 其他层 > 任意 */
  resolveModel(tier: ModelTier, override?: string): GatewayModel | undefined
  /** 调用（带降级：模型不可用 403/402 → 换候选；参数/网络错 → 直接抛） */
  invoke(tier: ModelTier, messages: ChatMessage[], tools?: ToolContract[], override?: string): Promise<ModelResponse>
  /** SSE 流式调用（实时增量输出，用于 UI 逐字渲染） */
  stream(tier: ModelTier, messages: ChatMessage[], tools?: ToolContract[], override?: string): AsyncIterable<StreamChunk>
}

export function createLlmGateway(models: GatewayModel[]): LlmGateway {
  const byId = new Map(models.map((m) => [m.id, m]))
  const providers = new Map<string, DeepSeekProvider>()

  function providerFor(model: GatewayModel): DeepSeekProvider {
    let p = providers.get(model.id)
    if (!p) {
      p = new DeepSeekProvider({ apiKey: model.apiKey, baseUrl: model.baseUrl, model: model.id })
      providers.set(model.id, p)
    }
    return p
  }

  /** 候选列表：override > 同层 > 其他层（去重） */
  function candidates(tier: ModelTier, override?: string): GatewayModel[] {
    const list: GatewayModel[] = []
    if (override && byId.has(override)) list.push(byId.get(override)!)
    for (const m of models) if (m.tier === tier) list.push(m)
    for (const m of models) if (m.tier !== tier) list.push(m)
    return [...new Map(list.map((m) => [m.id, m])).values()]
  }

  /** 模型不可用（403 无权限 / 402 余额不足）才降级，其余直接抛 */
  function isUnavailable(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('403') || msg.includes('402') || msg.includes('insufficient')
  }

  return {
    resolveModel(tier, override) {
      return candidates(tier, override)[0]
    },

    async invoke(tier, messages, tools, override) {
      const list = candidates(tier, override)
      let lastErr: unknown
      for (const model of list) {
        try {
          return await providerFor(model).complete(messages, tools)
        } catch (err) {
          if (!isUnavailable(err)) throw err
          lastErr = err
        }
      }
      throw lastErr ?? new Error(`no available model for tier ${tier}`)
    },

    async *stream(tier, messages, tools, override) {
      const model = this.resolveModel(tier, override)
      if (!model) throw new Error(`no model for tier ${tier}`)
      yield* providerFor(model).stream!(messages, tools)
    },
  }
}
