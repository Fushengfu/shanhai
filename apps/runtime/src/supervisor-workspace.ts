import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, relative, dirname } from 'node:path'
import type { ToolContract } from '@shanhai/tools'

/**
 * 会话管家台账（ledger）模块。
 *
 * 管家负责跨会话的调度与监控，需要一个「自己的」持久化速查台账：
 * - 工作目录独立于普通会话（普通会话共用 ~/shanhai/workspace，管家用 ~/.shanhai/supervisor-workspace）；
 * - 按会话 id 维护子目录，每个会话目录内放 notes.md（自然语言备注）+ state.json（结构化状态）；
 * - 顶层 _index.json 做「会话 id → 标题」的可读索引。
 *
 * state.json 是「任务计划/进度」的结构化载体，约定 schema（供管家统一读写，程序侧不强制解析）：
 * {
 *   "goal": "该会话要达成的总体目标（如：开发商城系统）",
 *   "plan": "需求分析与方案设计摘要",
 *   "tasks": [
 *     { "id": 1, "title": "需求分析", "status": "todo", "result": "" }
 *   ],
 *   "updatedAt": 1730000000000
 * }
 * status 状态机：todo(待办) → doing(进行中) → done(已完成) / blocked(阻塞)。
 * 管家作为「项目经理」按此清单逐个下发任务、回传后更新 status/result，清单清空即收工。
 *
 * 这里只提供「锚定 + 强限制在管家台账目录内、免审批」的原子工具，
 * 目录结构是给管家的「约定」，由管家通过工具自行读写，程序侧不强制解析其内容。
 */

/** 管家台账工作目录：独立于普通会话工作目录 */
export const SUPERVISOR_WORKSPACE = join(homedir(), '.shanhai', 'supervisor-workspace')

/** 初始化台账根目录（不存在则递归创建） */
export async function ensureSupervisorWorkspace(): Promise<void> {
  await fs.mkdir(SUPERVISOR_WORKSPACE, { recursive: true })
}

/** 删除某个会话的台账子目录（删除会话时联动清理；目录不存在则忽略） */
export async function removeSessionLedger(sessionId: string): Promise<void> {
  const dir = resolve(SUPERVISOR_WORKSPACE, sessionId)
  await fs.rm(dir, { recursive: true, force: true })
}

/**
 * 把台账路径解析到管家台账目录内：相对路径拼到台账根目录、绝对路径原样解析，
 * 但两者都强校验必须落在台账目录内（前缀校验），越界一律抛错——台账工具不允许访问台账目录之外的任何文件。
 * 空串返回台账根目录（供 list_ledger 列出根）。
 */
function resolveLedgerPath(p: string): string {
  const base = resolve(SUPERVISOR_WORKSPACE)
  const raw = (p ?? '').trim()
  const target = raw === '' ? base : isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`台账路径越界：仅允许访问管家台账目录 ${base} 内的文件，收到 "${p}"`)
  }
  return target
}

/** 树形列出台账目录（目录在前，按名称排序；maxDepth 控制递归深度） */
async function buildLedgerTree(dir: string, maxDepth: number): Promise<string> {
  const base = resolve(SUPERVISOR_WORKSPACE)
  const rootLabel = relative(base, dir) || '(root)'
  const lines: string[] = [rootLabel + '/']
  const walk = async (cur: string, prefix: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: Array<{ name: string; isDir: boolean }> = []
    try {
      const list = await fs.readdir(cur, { withFileTypes: true })
      entries = list.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch {
      return
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (!e) continue
      const last = i === entries.length - 1
      const connector = last ? '└── ' : '├── '
      const childPrefix = prefix + (last ? '    ' : '│   ')
      if (e.isDir) {
        lines.push(prefix + connector + e.name + '/')
        await walk(join(cur, e.name), childPrefix, depth + 1)
      } else {
        lines.push(prefix + connector + e.name)
      }
    }
  }
  await walk(dir, '', 1)
  return lines.join('\n')
}

/** 台账根目录本身（用于判断 read/write/edit 是否误指向目录） */
function ledgerBase(): string {
  return resolve(SUPERVISOR_WORKSPACE)
}

/**
 * 构造管家台账工具集。四个工具全部：
 * - 锚定 + 强限制在 SUPERVISOR_WORKSPACE 内（越界抛错，绝对路径也无法逃逸）；
 * - 免审批（读写管家自己的台账无需用户确认，避免「管家等审批、审批等管家」死锁）。
 */
export function createSupervisorLedgerTools(): ToolContract[] {
  return [
    {
      name: 'list_ledger',
      description:
        '以树形列出管家台账目录结构。台账位于管家私有工作目录，按会话 id 分子目录，每个会话目录内通常有 notes.md（自然语言备注）与 state.json（结构化状态），顶层 _index.json 是「会话 id → 标题」索引。' +
        'path 缺省列台账根目录，可传相对路径列某个会话子目录；maxDepth 控制深度（默认 2）。只读，不改变任何状态。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '台账目录相对路径，缺省列根目录' },
          maxDepth: { type: 'number', description: '递归深度，默认 2' },
        },
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const dir = resolveLedgerPath(String(args.path ?? ''))
        const maxDepth = typeof args.maxDepth === 'number' ? Math.max(1, Math.floor(args.maxDepth)) : 2
        return buildLedgerTree(dir, maxDepth)
      },
    },
    {
      name: 'read_ledger',
      description:
        '读取管家台账目录内的文件内容（如某会话的 notes.md / state.json / 顶层 _index.json）。' +
        'path 为台账目录内的相对路径（如 "某个会话id/notes.md"）。只能读台账目录内文件，不能读台账目录之外。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '台账文件相对路径（相对台账根目录）' },
        },
        required: ['path'],
      },
      riskLevel: 'readonly',
      execute: async (args) => {
        const p = resolveLedgerPath(String(args.path ?? ''))
        if (p === ledgerBase()) throw new Error('read_ledger 请指定具体文件路径（不能读台账根目录本身）')
        return fs.readFile(p, 'utf8')
      },
    },
    {
      name: 'write_ledger',
      description:
        '写入（覆盖）管家台账目录内的文件，用于更新某个会话的 state.json 或 notes.md。' +
        'path 为台账目录内的相对路径；content 为完整新内容。会自动创建缺失的父目录。只能写台账目录内文件。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '台账文件相对路径（相对台账根目录）' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['path', 'content'],
      },
      riskLevel: 'reversible',
      execute: async (args) => {
        const p = resolveLedgerPath(String(args.path ?? ''))
        if (p === ledgerBase()) throw new Error('write_ledger 请指定具体文件路径（不能覆盖台账根目录本身）')
        await fs.mkdir(dirname(p), { recursive: true })
        await fs.writeFile(p, String(args.content ?? ''), 'utf8')
        return { ok: true, path: relative(ledgerBase(), p) }
      },
    },
    {
      name: 'edit_ledger',
      description:
        '局部编辑管家台账目录内的文件：将 oldText 精确替换为 newText（只改片段，无需重传全文）。' +
        'path 为台账目录内的相对路径。默认替换首次命中；oldText 多次出现时设 replaceAll=true 替换全部。只能编辑台账目录内文件。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '台账文件相对路径（相对台账根目录）' },
          oldText: { type: 'string', description: '要被替换的原文本（必须精确匹配）' },
          newText: { type: 'string', description: '替换后的新文本' },
          replaceAll: { type: 'boolean', description: '是否替换全部命中，默认 false' },
        },
        required: ['path', 'oldText', 'newText'],
      },
      riskLevel: 'reversible',
      execute: async (args) => {
        const p = resolveLedgerPath(String(args.path ?? ''))
        if (p === ledgerBase()) throw new Error('edit_ledger 请指定具体文件路径（不能编辑台账根目录本身）')
        const oldText = String(args.oldText ?? '')
        if (oldText === '') throw new Error('edit_ledger 缺少 oldText：请提供要被替换的原文本片段')
        const newText = String(args.newText ?? '')
        const replaceAll = args.replaceAll === true

        let before: string
        try {
          before = await fs.readFile(p, 'utf8')
        } catch {
          throw new Error(`edit_ledger 读取失败：${p} 不存在，请先用 read_ledger 确认实际内容`)
        }
        const count = before.split(oldText).length - 1
        if (count === 0) {
          throw new Error('edit_ledger 未找到 oldText：文件中不存在该片段，请先用 read_ledger 读取实际内容确保精确匹配')
        }
        if (!replaceAll && count > 1) {
          throw new Error(`edit_ledger 命中 ${count} 处：请提供更长的 oldText 精确定位，或设置 replaceAll=true`)
        }
        const after = replaceAll
          ? before.split(oldText).join(newText)
          : before.slice(0, before.indexOf(oldText)) + newText + before.slice(before.indexOf(oldText) + oldText.length)
        await fs.writeFile(p, after, 'utf8')
        return { ok: true, path: relative(ledgerBase(), p), occurrences: replaceAll ? count : 1 }
      },
    },
  ]
}
