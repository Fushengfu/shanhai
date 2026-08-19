import type { ToolContract } from './tools'

/**
 * 通用工具的依赖注入（由 runtime 装配能力，工具定义集中在此，不散落在 bootstrap）。
 * 缺省某个能力则不注册对应工具。
 */
export interface UtilityDeps {
  /** 视觉模型分析图片（image_analyze 用） */
  analyzeImage?: (imageUrl: string) => Promise<string>
  /** 快照回滚（rollback_file 用，runtime 注入 FileSnapshotStore 能力并解析相对路径） */
  rollbackFile?: (path: string, snapshotId: string) => Promise<{ ok: boolean; path: string; rolledBack: boolean }>
  /** 长期记忆（remember / recall_memory 用，runtime 注入 MemoryStore 并负责持久化） */
  memory?: {
    save(scope: string, key: string, value: unknown): unknown
    recall(scope: string, keyword?: string): unknown[]
    list(): unknown[]
  }
}

/**
 * 创建通用工具（视觉分析 / 快照回滚 / 长期记忆）。
 * 这些工具不依赖特定大插件（computer-use / browser-use / ask），统一收敛到 tools 包，通过依赖注入解耦。
 */
export function createUtilityTools(deps: UtilityDeps): ToolContract[] {
  const tools: ToolContract[] = []
  if (deps.analyzeImage) tools.push(imageAnalyzeTool(deps.analyzeImage))
  if (deps.rollbackFile) tools.push(rollbackFileTool(deps.rollbackFile))
  if (deps.memory) tools.push(rememberTool(deps.memory), recallMemoryTool(deps.memory))
  return tools
}

/** image_analyze：用视觉模型分析图片（当前模型不支持多模态时，AI 调它理解图片内容） */
function imageAnalyzeTool(analyzeImage: (imageUrl: string) => Promise<string>): ToolContract {
  return {
    name: 'image_analyze',
    description: '分析图片内容并返回文字描述。当需要理解图片内容、但当前模型无法直接查看图片时使用。',
    inputSchema: {
      type: 'object',
      properties: { imageUrl: { type: 'string', description: '图片的 URL 或 data: URL' } },
      required: ['imageUrl'],
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const imageUrl = String(args.imageUrl ?? '')
      if (!imageUrl) return '（未提供图片）'
      return analyzeImage(imageUrl)
    },
  }
}

/** rollback_file：把文件恢复到 write_file 之前的快照（撤销写入） */
function rollbackFileTool(rollbackFile: (path: string, snapshotId: string) => Promise<{ ok: boolean; path: string; rolledBack: boolean }>): ToolContract {
  return {
    name: 'rollback_file',
    description:
      '把文件回滚到最近一次 write_file 之前的快照，恢复原内容（撤销写入）。' +
      'path 是目标文件路径（绝对路径或相对当前工作目录），snapshotId 是 write_file 返回结果里的 snapshotId。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        snapshotId: { type: 'string', description: 'write_file 返回的快照 id' },
      },
      required: ['path', 'snapshotId'],
    },
    riskLevel: 'reversible',
    execute: async (args) => {
      const path = String(args.path ?? '')
      const snapshotId = String(args.snapshotId ?? '')
      if (!path) return { ok: false, error: '缺少 path' }
      if (!snapshotId) return { ok: false, error: '缺少 snapshotId' }
      return rollbackFile(path, snapshotId)
    },
  }
}

/** remember：保存一条长期记忆（scope 决定层：配置型全量注入 / 经验型相关性召回） */
function rememberTool(memory: NonNullable<UtilityDeps['memory']>): ToolContract {
  return {
    name: 'remember',
    description:
      '保存一条长期记忆（跨会话生效）。当用户表达偏好、项目背景、环境约定或任务经验时使用。' +
      'scope 可选：user_preference（用户偏好）、project_knowledge（项目知识）、environment（环境约定）、task_experience（任务经验）。' +
      'key 是记忆名，value 是记忆内容。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '记忆作用域' },
        key: { type: 'string', description: '记忆名' },
        value: { type: 'string', description: '记忆内容' },
      },
      required: ['scope', 'key', 'value'],
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const scope = String(args.scope ?? '')
      const key = String(args.key ?? '')
      const value = args.value
      if (!scope || !key) return { ok: false, error: 'scope 和 key 不能为空' }
      const entry = memory.save(scope, key, value) as { id?: number }
      return { ok: true, id: entry.id, scope, key }
    },
  }
}

/** recall_memory：召回长期记忆（按作用域 + 关键词） */
function recallMemoryTool(memory: NonNullable<UtilityDeps['memory']>): ToolContract {
  return {
    name: 'recall_memory',
    description: '召回长期记忆。按 scope 过滤、keyword 关键词匹配，返回最新的在前。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '记忆作用域（可选）' },
        keyword: { type: 'string', description: '关键词（可选）' },
      },
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const scope = args.scope ? String(args.scope) : undefined
      const keyword = args.keyword ? String(args.keyword) : undefined
      const list = scope ? memory.recall(scope, keyword) : memory.list().reverse()
      return { items: list }
    },
  }
}
