import { promises as fs } from 'node:fs'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, isAbsolute, join } from 'node:path'

const exec = promisify(execCallback)

/** 工具风险等级（安全属性内嵌于契约） */
export type RiskLevel = 'readonly' | 'reversible' | 'irreversible' | 'high'

/**
 * 工具契约：一个工具的完整定义。
 *
 * description 是隐式 prompt——写清「何时用 / 参数含义 / 返回什么 / 何时不能用」，
 * 直接决定模型调用准确率。风险等级 + approvalRequired 让安全层统一拦截。
 */
export interface ToolContract {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  riskLevel: RiskLevel
  approvalRequired?: boolean
  timeoutMs?: number
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

/** 把用户给的路径解析到会话工作目录：绝对路径原样返回，相对路径拼到工作目录下。 */
type PathResolver = (p: string) => string

/** 写前快照回调：文件存在时备份（返回快照 id），新文件返回 undefined（无需快照）。由 runtime 层注入 FileSnapshotStore。 */
export type SnapshotFn = (path: string) => Promise<{ snapshotId: string } | undefined>

/**
 * 树形列出一个目录（`tree` 风格 ASCII 输出，供 list_dir 工具直接返回给模型与前端）。
 * 隐藏文件 / node_modules / dist 默认跳过，避免噪声；maxDepth 控制深度，maxEntries 控制条目数。
 */
async function buildDirTree(
  dir: string,
  maxDepth: number,
  maxEntries: number,
): Promise<string> {
  const counter = { n: 0 }
  const rootName = resolve(dir)
  const walk = async (current: string, prefix: string, depth: number): Promise<string> => {
    if (depth >= maxDepth || counter.n >= maxEntries) return ''
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return ''
    }
    const visible = entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1
        const bd = b.isDirectory() ? 0 : 1
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name)
      })
    let out = ''
    for (let i = 0; i < visible.length; i++) {
      if (counter.n >= maxEntries) {
        out += `${prefix}...\n`
        break
      }
      const e = visible[i]
      if (!e) continue
      const isLast = i === visible.length - 1
      const branch = isLast ? '└── ' : '├── '
      const childPrefix = prefix + (isLast ? '    ' : '│   ')
      counter.n += 1
      out += `${prefix}${branch}${e.name}${e.isDirectory() ? '/' : ''}\n`
      if (e.isDirectory()) {
        out += await walk(join(current, e.name), childPrefix, depth + 1)
      }
    }
    return out
  }
  const body = await walk(rootName, '', 0)
  return `${rootName}/\n${body}`.trimEnd()
}

/**
 * 创建内置原子工具清单。所有文件/命令操作都围绕 `getCwd()` 返回的会话工作目录：
 * 相对路径解析到工作目录下，命令也以工作目录为 cwd 执行——保证「工具围绕当前工作目录」这一约束。
 * `snapshot` 为写前快照回调（可选）：注入后 write_file 在覆盖已有文件前自动备份，支撑「信任四可」的可回退。
 */
export function createAtomicTools(getCwd: () => string, snapshot?: SnapshotFn): ToolContract[] {
  const resolvePath: PathResolver = (p) => {
    if (isAbsolute(p)) return p
    return resolve(getCwd(), p)
  }

  /** read_file：读取文件内容（相对路径解析到工作目录） */
  const readFileTool: ToolContract = {
    name: 'read_file',
    description:
      '读取指定路径的文本文件内容。当需要查看文件内容时使用。' +
      'path 可以是绝对路径，也可以是相对于当前工作目录的相对路径（优先使用相对路径，保持操作范围在工作目录内）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径（绝对路径，或相对当前工作目录的相对路径）' } },
      required: ['path'],
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const path = resolvePath(String(args.path))
      return fs.readFile(path, 'utf8')
    },
  }

  /** write_file：写入文件（可逆，默认需审批） */
  const writeFileTool: ToolContract = {
    name: 'write_file',
    description:
      '写入文本内容到指定路径（覆盖）。会修改文件，默认需用户确认。' +
      'path 可以是绝对路径，也可以是相对于当前工作目录的相对路径。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径，或相对当前工作目录的相对路径）' },
        content: { type: 'string', description: '要写入的内容' },
      },
      required: ['path', 'content'],
    },
    riskLevel: 'reversible',
    approvalRequired: true,
    execute: async (args) => {
      const path = resolvePath(String(args.path))
      const content = String(args.content)
      // 写入前读取旧内容，供前端渲染 git diff 效果；文件不存在则为 null（新建）
      let before: string | null = null
      try {
        before = await fs.readFile(path, 'utf8')
      } catch {
        before = null
      }
      // 写前快照：覆盖已有文件时备份（新文件无需快照），支撑回滚
      let snapshotId: string | undefined
      if (before !== null && snapshot) {
        try {
          snapshotId = (await snapshot(path))?.snapshotId
        } catch {
          snapshotId = undefined
        }
      }
      await fs.writeFile(path, content, 'utf8')
      return { ok: true, path, before, after: content, isNew: before === null, snapshotId }
    },
  }

  /** run_command：执行 shell 命令（不可逆，默认需审批），cwd 为会话工作目录 */
  const runCommandTool: ToolContract = {
    name: 'run_command',
    description:
      '在用户系统上执行 shell 命令。危险操作，默认需用户确认。命令会在当前工作目录下执行。',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
      required: ['command'],
    },
    riskLevel: 'irreversible',
    approvalRequired: true,
    execute: async (args) => {
      const { stdout, stderr } = await exec(String(args.command), { cwd: getCwd() })
      return { stdout, stderr }
    },
  }

  /** list_dir：树形列出目录（只读，无需审批） */
  const listDirTool: ToolContract = {
    name: 'list_dir',
    description:
      '以树形结构列出目录内容。当需要了解项目/目录结构、查找文件位置时使用。' +
      'path 默认为当前工作目录；maxDepth 控制递归深度（默认 3）。返回 tree 风格的树形文本。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径（默认当前工作目录，可传相对或绝对路径）' },
        maxDepth: { type: 'number', description: '递归深度，默认 3' },
      },
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const raw = args.path ? String(args.path) : ''
      const dir = raw ? resolvePath(raw) : getCwd()
      const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 3
      return buildDirTree(dir, maxDepth, 300)
    },
  }

  return [readFileTool, writeFileTool, runCommandTool, listDirTool]
}
