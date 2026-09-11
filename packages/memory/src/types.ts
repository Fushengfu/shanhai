export type MemoryScope =
  | 'session'
  | 'user_preference'
  | 'environment'
  | 'task_experience'
  | 'project_knowledge'
  | 'data_cognition'

export type MemorySource = 'explicit' | 'inferred' | 'observed'

/** 全部合法 scope（顺序即【任务256】vault 底座遍历的稳定顺序） */
export const ALL_SCOPES: MemoryScope[] = [
  'session',
  'user_preference',
  'environment',
  'task_experience',
  'project_knowledge',
  'data_cognition',
]

export function isMemoryScope(v: unknown): v is MemoryScope {
  return typeof v === 'string' && (ALL_SCOPES as string[]).includes(v)
}

export function isMemorySource(v: unknown): v is MemorySource {
  return v === 'explicit' || v === 'inferred' || v === 'observed'
}

export interface MemoryEntry {
  id: number
  scope: MemoryScope
  key: string
  value: unknown
  source: MemorySource
  confidence: number
  timestamp: number
  /** 所属会话 id；空/缺省视为全局（旧数据），不参与任何会话的召回 */
  sessionId?: string
  /** 【任务256】首次创建时间（ms）。迁移条目 = 原 timestamp；缺省时回退 timestamp */
  created?: number
  /** 【任务256】最近一次写入时间（ms）。**用于判定「文件是否被用户手改过」**（mtime > updated ⇒ 手改优先） */
  updated?: number
  /** 【任务256】无会话归属的存量记忆（落到 vault 的 `_global/`），等待用户指定归属 */
  needsOwner?: boolean
}

/** 配置型 scope：全量注入、写前归档、可回滚 */
export const CONFIG_SCOPES: MemoryScope[] = [
  'user_preference',
  'environment',
  'project_knowledge',
  'data_cognition',
]

/** 经验型 scope：相关性召回、置信度标注 */
export const EXPERIENCE_SCOPES: MemoryScope[] = ['task_experience']

export type MemoryLayer = 'short' | 'working' | 'config' | 'experience'

/** 判断 scope 所属记忆层 */
export function layerOf(scope: MemoryScope): MemoryLayer {
  if (scope === 'session') return 'short'
  if (EXPERIENCE_SCOPES.includes(scope)) return 'experience'
  return 'config'
}
