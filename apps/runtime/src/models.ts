import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createMockModel, createModelProvider } from '@shanhai/llm'
import type { Model, TokenUsage, HttpTraceCallback } from '@shanhai/llm'
import { resolveBuiltinReasoningEffort } from '@shanhai/auth'
import type { GatewayModel, ModelTier } from '@shanhai/auth'

/** 从本地凭证装配真实网关模型；无凭证则 mock 兜底 */
export async function createGatewayModel(onUsage?: (usage: TokenUsage) => void, onTrace?: HttpTraceCallback): Promise<Model> {
  try {
    const raw = await fs.readFile(join(homedir(), '.shanhai', 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as {
      gateway?: { baseUrl?: string; apiKey?: string; selectedModelId?: string }
    }
    const g = cfg.gateway
    if (g?.baseUrl && g?.apiKey && g?.selectedModelId) {
      return createModelProvider({ apiKey: g.apiKey, baseUrl: g.baseUrl, model: g.selectedModelId, onUsage, onTrace })
    }
  } catch {
    // 无凭证，走 mock
  }
  return createMockModel([{ text: '你好，我是山海智能体。' }])
}

export function inferTier(id: string): ModelTier {
  if (/flash|step-3/i.test(id)) return 'value'
  return 'flagship'
}

/** 视觉模型匹配提示词（这些厂商的模型通常支持多模态视觉） */
const VISION_HINTS = ['qwen', 'kimi', 'mimo', 'minimax', 'longcat', 'glm', 'vision', 'vl', 'omni', 'step']

export function isVisionModel(id: string): boolean {
  const lower = id.toLowerCase()
  return VISION_HINTS.some((h) => lower.includes(h))
}

/** 判断模型是否支持视觉：优先用接口返回的 supportsVision 字段，缺省时回退 id 猜测 */
export function modelSupportsVision(m: GatewayModel | undefined): boolean {
  if (!m) return false
  if (m.supportsVision !== undefined) return m.supportsVision
  return isVisionModel(m.id)
}

/** 用 apiKey 拉取网关完整模型列表（/api/v1/models，各自上游 baseUrl）。apiKey 长期有效，网关禁用的模型不在返回里，可作「当前启用模型白名单」 */
export async function fetchGatewayModels(apiKey: string, baseUrl: string): Promise<GatewayModel[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      code?: number
      data?: {
        data?: Array<{
          id: string
          name?: string
          displayName?: string
          baseUrl?: string
          model?: string
          contextLength?: number
          maxTokens?: string | number
          temperature?: string | number
          provider?: string
          supportsVision?: boolean
          supportsReasoning?: boolean
          reasoningEffort?: string
          sortOrder?: number
          description?: string
          source?: string
          modelType?: string
        }>
      }
    }
    const list = data.data?.data ?? []
    return list.map((m) => {
      // 仅在「网关未下发 effort 且模型支持思考(supportsReasoning=true)」时用内置表补档；否则保持网关原样（不注入）
      const builtinEffort =
        m.reasoningEffort != null || m.supportsReasoning !== true
          ? undefined
          : resolveBuiltinReasoningEffort(String(m.id ?? m.model ?? ''))
      return {
        id: m.id,
        name: m.displayName ?? m.name ?? m.id,
        displayName: m.displayName != null ? String(m.displayName) : undefined,
        model: m.model != null ? String(m.model) : undefined,
        tier: inferTier(m.id),
        apiKey,
        baseUrl: m.baseUrl ?? baseUrl,
        contextLength: typeof m.contextLength === 'number' ? m.contextLength : undefined,
        maxTokens: m.maxTokens != null ? Number(m.maxTokens) : undefined,
        temperature: m.temperature != null ? String(m.temperature) : undefined,
        provider: m.provider != null ? String(m.provider) : undefined,
        supportsVision: m.supportsVision === true,
        supportsReasoning: m.supportsReasoning === true,
        reasoningEffort: m.reasoningEffort != null ? String(m.reasoningEffort) : builtinEffort?.defaultEffort,
        reasoningEfforts: builtinEffort?.efforts,
        sortOrder: typeof m.sortOrder === 'number' ? m.sortOrder : undefined,
        description: m.description != null ? String(m.description) : undefined,
        source: m.source != null ? String(m.source) : undefined,
        modelType: m.modelType != null ? String(m.modelType) : undefined,
      }
    })
  } catch {
    return []
  }
}
