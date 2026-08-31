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

  // 联动清理顶层 _index.json 里该会话的索引条目，避免「删除会话后索引残留指向已删会话」。
  // _index.json 是模型维护的速查索引（结构 { updatedAt, sessions: { <id>: { title, tags } } }），
  // 这里只删 sessions 下对应的 id 键，不重建结构、不更新 updatedAt，保持最小侵入。
  const indexPath = join(SUPERVISOR_WORKSPACE, '_index.json')
  try {
    const raw = await fs.readFile(indexPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      if (Object.prototype.hasOwnProperty.call(parsed.sessions, sessionId)) {
        delete parsed.sessions[sessionId]
        await fs.writeFile(indexPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
      }
    }
  } catch {
    // _index.json 不存在 / 损坏 / 结构异常时忽略：索引清理失败不应阻断删除会话主流程。
  }
}

/**
 * 把台账路径解析到管家台账目录内：相对路径拼到台账根目录、绝对路径原样解析，
 * 但两者都强校验必须落在台账目录内（前缀校验），越界一律抛错——台账工具不允许访问台账目录之外的任何文件。
 * 空串返回台账根目录（供 ledger(list) 列出根）。
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
 * 构造管家台账工具集：收敛为单个顶层工具 ledger，内部用 action 分派（与 plugin_manage 同款收敛）。
 * 所有 action 都：
 * - 锚定 + 强限制在 SUPERVISOR_WORKSPACE 内（越界抛错，绝对路径也无法逃逸）；
 * - 免审批（读写管家自己的台账无需用户确认，避免「管家等审批、审批等管家」死锁）。
 * action 枚举：
 * - list  ：树形列出台账目录（入参 path? / maxDepth?）
 * - read  ：读台账文件（入参 path）
 * - write ：覆盖写台账文件（入参 path / content）
 * - edit  ：局部编辑台账文件（入参 path / oldText / newText / replaceAll?）
 */
export function createSupervisorLedgerTools(): ToolContract[] {
  return [
    {
      name: 'ledger',
      description:
        '管家台账工具（统一入口，用 action 分派）：维护持久化跨会话状态的速查记录，位于管家私有工作目录 ~/.shanhai/supervisor-workspace/，按会话 id 分子目录，每个会话目录内通常有 notes.md（自然语言备注）与 state.json（结构化状态），顶层 _index.json 是「会话 id → 标题」索引。只能访问台账目录内文件，越界一律拒绝。' +
        'action 取值：' +
        'list —— 以树形列出台账目录结构（入参 path 缺省列根目录、可传相对路径列某会话子目录；maxDepth 控制深度，默认 2）；' +
        'read —— 读取台账文件内容（入参 path 为台账目录内相对路径，如 "某会话id/notes.md"）；' +
        'write —— 写入（覆盖）台账文件，自动创建缺失父目录（入参 path 相对路径 + content 完整新内容）；' +
        'edit —— 局部编辑台账文件，把 oldText 精确替换为 newText（入参 path + oldText + newText，oldText 多处命中时设 replaceAll=true 全部替换）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'write', 'edit'],
            description: '要执行的动作：list 列目录 / read 读文件 / write 覆盖写 / edit 局部编辑',
          },
          path: { type: 'string', description: '台账目录内相对路径（list 时可省略列根目录；read/write/edit 必填指定文件）' },
          content: { type: 'string', description: 'write 时：要写入的完整新内容' },
          oldText: { type: 'string', description: 'edit 时：要被替换的原文本片段（必须精确匹配）' },
          newText: { type: 'string', description: 'edit 时：替换后的新文本' },
          replaceAll: { type: 'boolean', description: 'edit 时：是否替换全部命中，默认 false（只替换首个）' },
          maxDepth: { type: 'number', description: 'list 时：递归深度，默认 2' },
        },
        required: ['action'],
      },
      riskLevel: 'reversible',
      resolveRisk: (args) => {
        const action = String(args.action ?? '')
        if (action === 'list' || action === 'read') {
          return { riskLevel: 'readonly', approvalRequired: false, outsideWorkdir: false }
        }
        return { riskLevel: 'reversible', approvalRequired: false, outsideWorkdir: false }
      },
      execute: async (args) => {
        const action = String(args.action ?? '')
        if (action === 'list') {
          const dir = resolveLedgerPath(String(args.path ?? ''))
          const maxDepth = typeof args.maxDepth === 'number' ? Math.max(1, Math.floor(args.maxDepth)) : 2
          return buildLedgerTree(dir, maxDepth)
        }
        if (action === 'read') {
          const p = resolveLedgerPath(String(args.path ?? ''))
          if (p === ledgerBase()) throw new Error('ledger(read) 请指定具体文件路径（不能读台账根目录本身）')
          return fs.readFile(p, 'utf8')
        }
        if (action === 'write') {
          const p = resolveLedgerPath(String(args.path ?? ''))
          if (p === ledgerBase()) throw new Error('ledger(write) 请指定具体文件路径（不能覆盖台账根目录本身）')
          await fs.mkdir(dirname(p), { recursive: true })
          await fs.writeFile(p, String(args.content ?? ''), 'utf8')
          return { ok: true, path: relative(ledgerBase(), p) }
        }
        if (action === 'edit') {
          const p = resolveLedgerPath(String(args.path ?? ''))
          if (p === ledgerBase()) throw new Error('ledger(edit) 请指定具体文件路径（不能编辑台账根目录本身）')
          const oldText = String(args.oldText ?? '')
          if (oldText === '') throw new Error('ledger(edit) 缺少 oldText：请提供要被替换的原文本片段')
          const newText = String(args.newText ?? '')
          const replaceAll = args.replaceAll === true

          let before: string
          try {
            before = await fs.readFile(p, 'utf8')
          } catch {
            throw new Error(`ledger(edit) 读取失败：${p} 不存在，请先用 ledger(read) 确认实际内容`)
          }
          const count = before.split(oldText).length - 1
          if (count === 0) {
            throw new Error('ledger(edit) 未找到 oldText：文件中不存在该片段，请先用 ledger(read) 读取实际内容确保精确匹配')
          }
          if (!replaceAll && count > 1) {
            throw new Error(`ledger(edit) 命中 ${count} 处：请提供更长的 oldText 精确定位，或设置 replaceAll=true`)
          }
          const after = replaceAll
            ? before.split(oldText).join(newText)
            : before.slice(0, before.indexOf(oldText)) + newText + before.slice(before.indexOf(oldText) + oldText.length)
          await fs.writeFile(p, after, 'utf8')
          return { ok: true, path: relative(ledgerBase(), p), occurrences: replaceAll ? count : 1 }
        }
        throw new Error(`ledger 未知 action "${action}"：只支持 list / read / write / edit`)
      },
    },
  ]
}
