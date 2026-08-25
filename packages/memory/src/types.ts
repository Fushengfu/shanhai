export type MemoryScope =
  | 'session'
  | 'user_preference'
  | 'environment'
  | 'task_experience'
  | 'project_knowledge'
  | 'data_cognition'

export type MemorySource = 'explicit' | 'inferred' | 'observed'

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
