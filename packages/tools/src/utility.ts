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
    guide: {
      usage: [
        '当需要理解图片内容、但当前模型无法直接查看图片（无视觉能力）时使用，传入图片 URL 或 data: URL。',
        '当前模型支持视觉时不要用此工具，直接把图片作为多模态附件发给模型即可。',
      ],
      cautions: [
        '只接受 URL / data: URL，不接受本地文件路径。',
      ],
    },
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
    guide: {
      usage: [
        '撤销最近一次 write_file / edit_file 对文件的写入，恢复到写入前的快照状态。',
        'snapshotId 从 write_file 返回结果的 snapshotId 字段取。',
      ],
      cautions: [
        '只在确实需要撤销时用；快照不存在或已过期时回滚会失败。',
      ],
    },
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
    guide: {
      usage: [
        '当用户表达稳定偏好、项目背景、环境约定或可复用的任务经验时，主动保存为长期记忆（跨会话生效）。',
        'scope 选 user_preference（用户偏好）/ project_knowledge（项目知识）/ environment（环境约定）/ task_experience（任务经验）。',
      ],
      cautions: [
        '不要滥用：只记录真正稳定、跨会话有价值的信息，一次性临时信息不要记。',
      ],
    },
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

/** recall_memory 的默认返回条数上限（不传 `limit` 时生效） */
const DEFAULT_RECALL_LIMIT = 10

/** 子串出现次数（**不做大小写处理**，大小写不敏感由调用方先 toLowerCase） */
function countHits(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return n
    n += 1
    from = at + needle.length
  }
}

/** 记忆正文文本（value 可能是对象） */
function memoryText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * 召回打分：**key 命中权重 3、value 命中权重 1**，按出现次数累加（大小写不敏感）。
 * 目的：让「搜索词出现在标题里」的条目排在「正文里偶然提到」的前面。
 */
export function scoreMemoryHit(key: string, value: unknown, needle: string): number {
  if (!needle) return 0
  const n = needle.toLowerCase()
  return countHits(key.toLowerCase(), n) * 3 + countHits(memoryText(value).toLowerCase(), n)
}

/** 召回结果的对外投影：只带 AI 真正用得上的字段（正文 + 身份 + 时间 + 来源） */
function projectMemoryEntry(raw: unknown): Record<string, unknown> {
  const e = (raw ?? {}) as Record<string, unknown>
  return { id: e.id, scope: e.scope, key: e.key, value: e.value, timestamp: e.timestamp, source: e.source }
}

/** 排序：命中分降序 → 时间降序兜底（**不再是无条件 reverse 的时间倒序**） */
function rankMemories(list: unknown[], keyword?: string): unknown[] {
  return list
    .map((raw) => {
      const e = (raw ?? {}) as { key?: unknown; value?: unknown; timestamp?: unknown }
      return {
        raw,
        score: scoreMemoryHit(String(e.key ?? ''), e.value, keyword ?? ''),
        ts: Number(e.timestamp ?? 0),
      }
    })
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .map((x) => x.raw)
}

/**
 * recall_memory：召回长期记忆（按作用域 + 关键词）。
 *
 * 【任务259·P2】修掉「**不带 scope 时 keyword 被直接丢弃**」：
 * 旧实现是 `scope ? recall(scope, keyword) : list().reverse()`，
 * 于是「搜记忆」在无 scope 时退化成「把当前会话的全部记忆倒出来」——
 * 用户看到的「十几条不相关、纯时间倒序」就是它。
 * 现在：无 scope 时在**当前会话的全部 scope** 内按 key/value 子串过滤（**大小写不敏感**），
 * 再按命中分排序；`scope` 存在时**仍走 `memory.recall(scope, keyword)`**（既有子串语义逐字不动，不得退化）。
 */
function recallMemoryTool(memory: NonNullable<UtilityDeps['memory']>): ToolContract {
  return {
    name: 'recall_memory',
    description:
      '召回长期记忆。按 scope 过滤、keyword 关键词匹配（key 与正文都匹配，大小写不敏感），' +
      '按相关度排序返回、默认最多 10 条（可用 limit 调整）。' +
      '不传 scope 时在当前会话的全部作用域里搜；不传 keyword 时按时间倒序返回最近的记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '记忆作用域（可选；不传则搜全部作用域）' },
        keyword: { type: 'string', description: '关键词（可选；匹配 key 与正文，大小写不敏感）' },
        limit: { type: 'number', description: '返回条数上限（可选，默认 10）' },
      },
    },
    riskLevel: 'readonly',
    guide: {
      usage: [
        '需要回忆之前是否处理过类似问题、查找历史约定/偏好时，按 scope + 关键词召回长期记忆。',
        '记忆的存放位置与使用规则写在**本轮用户消息前的记忆块**里（该块只给位置与用法，**不列条目索引**）；' +
          '需要正文时用本工具按关键词（或 scope）取回。',
        '一次先用一个精准 keyword 试；结果按相关度排序（标题命中优先），默认只给前 10 条，需要更多再调大 limit。',
      ],
      cautions: [
        '纯关键词子串匹配，没有语义理解：换同义词搜不到时，换一个更短的词再试，不要连续多次调用。',
      ],
    },
    execute: async (args) => {
      const scope = args.scope ? String(args.scope) : undefined
      const keyword = args.keyword ? String(args.keyword) : undefined
      const rawLimit = Number(args.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_RECALL_LIMIT
      const matched = scope
        ? memory.recall(scope, keyword)
        : keyword
          ? memory.list().filter((raw) => {
              const e = (raw ?? {}) as { key?: unknown; value?: unknown }
              return scoreMemoryHit(String(e.key ?? ''), e.value, keyword) > 0
            })
          : memory.list()
      const ranked = rankMemories(matched, keyword)
      return { total: ranked.length, items: ranked.slice(0, limit).map(projectMemoryEntry) }
    },
  }
}
