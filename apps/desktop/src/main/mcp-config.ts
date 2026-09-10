/**
 * MCP 配置（`~/.shanhai/mcp.json`）的**读写**：列表 / 启停 / 编辑。
 *
 * 【为什么不改 packages/mcp 就能做「真启停」】
 *  `McpService.listServers()` 只遍历 `cfg.servers`（packages/mcp/src/service.ts:36，
 *  `loadConfig()` 也只取 `parsed.servers`）。所以把停用项从 `servers` 段**移到 `disabledServers` 段**，
 *  对任何 McpService 实例（含 AI 侧 runtime 里那个）都天然不可见 —— 是真停用，不是 UI 假开关。
 *  配置不丢（还在文件里）、格式向后兼容（老文件没有 `disabledServers` 段照常工作）。
 *
 * 【凭证红线（本文件是唯一的写入口）】
 *  - 下发渲染层：只给 env 的 **键名 + 常量掩码**（`maskedEnv`），原始值一个字节都不出主进程；
 *  - 收渲染层：`value === null` 表示「保持原值」—— 渲染层只拿得到掩码，物理上回传不了原值，
 *    所以「把界面掩码写回文件」这条错路被数据结构本身堵死；
 *  - 未提及的 env 键**原样保留**（merge，不是替换）；
 *  - 未知字段**原样保留**：顶层未知键不动，单个 server 条目里的未知键也不动（只在条目内改
 *    command / args / env 三个键）；
 *  - 写盘**原子**（写临时文件 + rename）+ 写前留一份 `mcp.json.bak`。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { McpManageListResult, McpManageResult, McpManagedServer, McpServerPatch } from '../shared/mcp-manage'
import { listMcpToolCounts, refreshMcp } from './skills-mcp'

/** env 原始值的掩码（**常量**，不泄露长度、前缀、后缀任何信息） */
const ENV_MASK = '••••••••'

/** 环境变量名合法性（与 shell 通行约定一致；非法名写进 mcp.json 只会让子进程启动失败） */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface McpConfigFileRaw {
  servers?: Record<string, McpServerEntry>
  /** 停用区（山海自有扩展段；McpService 不读它 ⇒ 停用项对 AI 不可见） */
  disabledServers?: Record<string, McpServerEntry>
  /** 保留其它未知顶层键（读-改-写不得丢） */
  [k: string]: unknown
}

interface McpServerEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
  [k: string]: unknown
}

export function mcpConfigPath(): string {
  return join(homedir(), '.shanhai', 'mcp.json')
}

async function readRaw(): Promise<{ raw: McpConfigFileRaw; text: string | null }> {
  const p = mcpConfigPath()
  try {
    const text = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { raw: {}, text }
    return { raw: parsed as McpConfigFileRaw, text }
  } catch {
    // 文件不存在 / 非法 JSON 都按「空配置」处理（与 McpService.loadConfig 的降级口径一致）
    return { raw: {}, text: null }
  }
}

function sectionOf(raw: McpConfigFileRaw, id: string): 'servers' | 'disabledServers' | null {
  if (raw.servers && typeof raw.servers[id] === 'object' && raw.servers[id] !== null) return 'servers'
  if (raw.disabledServers && typeof raw.disabledServers[id] === 'object' && raw.disabledServers[id] !== null) return 'disabledServers'
  return null
}

function entryToManaged(id: string, e: McpServerEntry, enabled: boolean): McpManagedServer {
  const envRaw = e.env && typeof e.env === 'object' ? e.env : {}
  return {
    id,
    command: typeof e.command === 'string' ? e.command : '',
    args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [],
    enabled,
    // ★绝不返回 env 的值，只返回键名 + 常量掩码
    env: Object.keys(envRaw).map((k) => ({ key: k, masked: String(envRaw[k] ?? '') === '' ? '' : ENV_MASK })),
  }
}

/** 列表：启用区 + 停用区合并返回；启用项才去探测工具数（探测会 spawn 子进程，带超时与降级） */
export async function listManagedServers(): Promise<McpManageListResult> {
  try {
    const { raw } = await readRaw()
    const enabled = Object.entries(raw.servers ?? {})
    const disabled = Object.entries(raw.disabledServers ?? {})
    const servers: McpManagedServer[] = [
      ...enabled.map(([id, e]) => entryToManaged(id, e, true)),
      ...disabled.map(([id, e]) => entryToManaged(id, e, false)),
    ]
    if (servers.some((s) => s.enabled)) {
      const counts = await listMcpToolCounts()
      const byId = new Map(counts.results.map((r) => [r.serverId, r]))
      for (const s of servers) {
        if (!s.enabled) continue
        const c = byId.get(s.id)
        if (c) {
          s.toolCount = c.count
          if (c.error) s.toolError = c.error
        }
      }
    }
    return { servers }
  } catch (err) {
    return { servers: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 原子写：备份 → 写临时文件 → rename。任何一步失败都向上返回错误（不静默） */
async function writeRawAtomic(raw: McpConfigFileRaw, prevText: string | null): Promise<McpManageResult> {
  const p = mcpConfigPath()
  const tmp = `${p}.tmp-${process.pid}`
  try {
    await fs.mkdir(join(homedir(), '.shanhai'), { recursive: true })
    if (prevText !== null) {
      // 写前留一份备份（覆盖上一份备份）—— 出问题时用户可手工回滚
      await fs.writeFile(`${p}.bak`, prevText, 'utf8')
    }
    await fs.writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    await fs.rename(tmp, p)
    // 写盘成功后让主进程侧的 McpService 重新读配置（否则它内存里还是旧配置）
    refreshMcp()
    return { ok: true }
  } catch (err) {
    try {
      await fs.rm(tmp, { force: true })
    } catch {
      // 清理失败不影响结论（临时文件残留不破坏主文件）
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 启停：把条目在两个段之间搬移（整条搬，条目内的未知字段一并保留） */
export async function setServerEnabled(id: string, enabled: boolean): Promise<McpManageResult> {
  const sid = String(id ?? '').trim()
  if (!sid) return { ok: false, error: '缺少服务标识' }
  const { raw, text } = await readRaw()
  const from = sectionOf(raw, sid)
  if (!from) return { ok: false, error: `MCP 服务不存在：${sid}` }
  const want: 'servers' | 'disabledServers' = enabled ? 'servers' : 'disabledServers'
  if (from === want) return { ok: true }
  const src = raw[from] ?? {}
  const entry = src[sid]
  // 类型守卫（noUncheckedIndexedAccess 下索引取值可能为 undefined；sectionOf 已保证存在）
  if (!entry) return { ok: false, error: `MCP 服务不存在：${sid}` }
  delete src[sid]
  if (Object.keys(src).length === 0) delete raw[from]
  const dst = (raw[want] ?? {}) as Record<string, McpServerEntry>
  dst[sid] = entry
  raw[want] = dst
  return writeRawAtomic(raw, text)
}

/**
 * 编辑保存（只改已存在的服务）。
 * 校验：command 非空；args 必须是字符串数组；env 键名合法；「保持原值」的键必须本来就存在。
 */
export async function saveServer(patch: McpServerPatch): Promise<McpManageResult> {
  const id = String(patch?.id ?? '').trim()
  if (!id) return { ok: false, error: '缺少服务标识' }
  const command = String(patch?.command ?? '').trim()
  if (!command) return { ok: false, error: '命令不能为空' }
  const rawArgs = patch?.args
  if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) {
    return { ok: false, error: '参数必须是字符串数组' }
  }
  const patchEnv = Array.isArray(patch?.env) ? patch.env : []
  const removed = Array.isArray(patch?.envRemoved) ? patch.envRemoved.filter((k): k is string => typeof k === 'string') : []

  const { raw, text } = await readRaw()
  const sec = sectionOf(raw, id)
  if (!sec) return { ok: false, error: `MCP 服务不存在：${id}` }
  const entry = (raw[sec] as Record<string, McpServerEntry>)[id]
  // 类型守卫（noUncheckedIndexedAccess）：理论上 sectionOf 已保证存在
  if (!entry || typeof entry !== 'object') return { ok: false, error: `MCP 服务不存在：${id}` }
  const existingEnv: Record<string, string> = entry.env && typeof entry.env === 'object' ? { ...entry.env } : {}

  // 先按「保持原值 + 未提及的键原样保留」算出目标 env
  const nextEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(existingEnv)) {
    if (removed.includes(k)) continue
    nextEnv[k] = v
  }
  for (const item of patchEnv) {
    const k = String(item?.key ?? '').trim()
    if (!k) continue
    if (!ENV_KEY_RE.test(k)) return { ok: false, error: `环境变量名不合法：${k}` }
    if (item.value === null || item.value === undefined) {
      // ★「保持原值」：新增的键没有任何原值可保持 ⇒ 必须填值，否则本次保存拒绝（可见反馈）
      if (!(k in existingEnv)) return { ok: false, error: `新增的环境变量 ${k} 必须填写值` }
      continue
    }
    nextEnv[k] = String(item.value)
  }

  // ★只改这三个键，条目里的未知字段（cwd / envFile / 其它）原样保留
  const nextEntry: McpServerEntry = { ...entry, command, args: rawArgs.slice() }
  if (Object.keys(nextEnv).length > 0) nextEntry.env = nextEnv
  else delete nextEntry.env
  ;(raw[sec] as Record<string, McpServerEntry>)[id] = nextEntry

  return writeRawAtomic(raw, text)
}
