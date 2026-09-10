/**
 * 账号悬停弹窗（AccountPopover）的**只读**数据源：本机技能清单 + 本机 MCP 服务器/工具数。
 *
 * 【为什么在主进程直接实例化，而不是从 runtime 取】
 * runtime 的公开面（`Runtime` 接口）没有暴露 `skillService` / `mcpService`（它们在
 * `apps/runtime/src/context.ts` 的 RuntimeContext 上，只给宿主内部用）。本轮授权范围是
 * 「只改 apps/desktop/src」，故在主进程侧独立实例化这两个服务：
 *  - 它们的数据来源是**同一份文件**（`~/.shanhai/skills/<id>/SKILL.md` 与 `~/.shanhai/mcp.json`），
 *    不存在第二份真相；
 *  - 不触碰 runtime 的任何判定（isSupervisor / currentSessionId / sessionOrigin /
 *    supervisorLoopTools / listSessions 过滤），也不写任何 runtime 状态；
 *  - 未走 `runtime.tools` 里已注册的 skill_list / mcp_list_tools 工具：那会经 wrapTool 包装，
 *    每调一次都往**当前会话的执行轨迹**里写一条 tool-call/tool-result（等于用户一悬停就污染轨迹），
 *    故刻意避开。
 *
 * 【安全】MCP 配置里的 `env`（可能含凭证）**一律不下发**：这里只回 id / command / args。
 */

import { SkillService } from '@shanhai/skills'
import { McpService, type ServerToolsResult } from '@shanhai/mcp'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import type {
  McpServerListResult,
  McpToolCountResult,
  SkillListResult,
  SkillSummary,
} from '../shared/account-services'
import type { SkillUninstallResult } from '../shared/skills-market'

/** MCP 工具数探测的单轮上限：超过就降级为「读取失败」，绝不卡住界面（listToolsOf 会 spawn 子进程） */
const MCP_TOOLS_TIMEOUT_MS = 5000

/** 工具数结果的复用窗口：悬停是高频动作，60s 内重复打开弹窗不再重新 spawn 子进程 */
const MCP_TOOLS_CACHE_MS = 60_000

/**
 * 技能服务实例（模块级）。**装完新技能必须换一个新的实例**：
 * `SkillService.list()` 会把扫描结果缓存在实例内，且该缓存没有对外失效接口
 * （`cache` 是私有字段，只有 `registerExecutable` 会清零）。
 * 换实例的代价 = 下次 list() 重新扫一遍 `~/.shanhai/skills/`（目录通常只有几十项，可忽略），
 * 好处是完全不碰 `packages/skills`（本轮硬边界：改动范围只到 apps/desktop/src）。
 */
let skillService = new SkillService()
let mcpService = new McpService()

/**
 * 让「本机 MCP 清单」下次读取时重新读 `~/.shanhai/mcp.json`。
 * `McpService.loadConfig()` 把配置缓存在实例内（packages/mcp/src/service.ts:74-84），
 * 所以 MCP 管理面板改完配置（编辑 / 启停）必须换一个新实例，否则这里仍是旧清单。
 * 同时清掉工具数缓存（启停后工具集会变，60s 复用窗口里的旧结果就不成立了）。
 */
export function refreshMcp(): void {
  mcpService = new McpService()
  toolsCache = null
}

/**
 * 让「本机技能清单」下次读取时重新扫描磁盘。
 * 技能市场装完一个技能后调用 —— 否则账号弹窗会一直显示安装前的旧列表（缓存命中）。
 */
export function refreshSkills(): void {
  skillService = new SkillService()
}

let toolsCache: { at: number; results: McpToolCountResult['results'] } | null = null
/** 进行中的探测（同一时刻只允许一轮，避免连续悬停拉起多批子进程） */
let toolsInflight: Promise<McpToolCountResult> | null = null

/** 把「可能永不落定」的 promise 收敛成带超时的结果（超时后用 fallback，底层 promise 继续走完再由调用方清理） */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    const done = (v: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    p.then(done, () => done(fallback))
  })
}

/**
 * 本机技能清单（只读）。
 * 返回 `SkillService.list()` 的展示子集：内置说明书技能 3 个（code-review / code-search /
 * plugin-protocol）+ `~/.shanhai/skills/<id>/SKILL.md` 解析出的用户技能。
 * 读目录不存在 / 单个技能损坏都由 SkillService 内部吞掉，不向上抛。
 */
export async function listSkills(): Promise<SkillListResult> {
  try {
    const all = await skillService.list()
    const skills: SkillSummary[] = all.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
    }))
    return { skills }
  } catch (err) {
    return { skills: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 本机已配置的 MCP 服务器（只读，来自 ~/.shanhai/mcp.json；不触发任何子进程） */
export async function listMcpServers(): Promise<McpServerListResult> {
  try {
    const servers = await mcpService.listServers()
    return { servers: servers.map((s) => ({ id: s.id, command: s.command, args: s.args })) }
  } catch (err) {
    return { servers: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 真正探测一次各服务器的工具数；无论成败都在底层 promise 落定后关掉本次拉起的连接 */
async function probeToolCounts(): Promise<McpToolCountResult> {
  const { servers, error } = await listMcpServers()
  if (error) return { results: [], error }
  const underlying = servers.map((s) => mcpService.listToolsOf(s.id))
  const settled = await Promise.all(
    underlying.map((p, i) => {
      const id = servers[i]?.id ?? ''
      return withTimeout<ServerToolsResult>(p, MCP_TOOLS_TIMEOUT_MS, {
        serverId: id,
        tools: [],
        error: 'timeout',
      })
    }),
  )
  const results = settled.map((r) => ({ serverId: r.serverId, count: r.tools.length, error: r.error }))
  // 清理：等底层全部落定后再 close —— 超时先返回时连接可能还在建立中，
  // McpService.close() 只关「已缓存的连接」，早关会留下孤儿 stdio 子进程。
  void Promise.allSettled(underlying)
    .then(() => mcpService.close())
    .catch(() => undefined)
  return { results }
}

/**
 * 各 MCP 服务器的工具数（只读探测）。
 * 连接失败 / 超时逐台降级（count=0 + error），不编数字、不卡界面；60s 内复用上次结果。
 */
export function listMcpToolCounts(): Promise<McpToolCountResult> {
  if (toolsCache && Date.now() - toolsCache.at < MCP_TOOLS_CACHE_MS) {
    return Promise.resolve({ results: toolsCache.results })
  }
  if (toolsInflight) return toolsInflight
  const run = probeToolCounts()
    .then((r) => {
      if (!r.error) toolsCache = { at: Date.now(), results: r.results }
      return r
    })
    .catch((err: unknown) => ({ results: [], error: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      toolsInflight = null
    })
  toolsInflight = run
  return run
}

// ——————————————————————————————————————————————————————————————
// 卸载（技能市场的「已安装」tab）：**本文件里唯一会删磁盘的函数**
// ——————————————————————————————————————————————————————————————

/**
 * 技能根目录。与 `SkillService` 的默认构造参数**同源同值**
 * （packages/skills/src/skill.ts 的 `join(homedir(), '.shanhai', 'skills')`）：
 * 这里刻意重算一遍而不去问服务实例——`SkillService` 没暴露 `skillsDir`，
 * 而「取到根目录」是路径夹取的必要输入，值必须与扫描源一致（否则校验失去意义）。
 */
const SKILLS_DIR = join(homedir(), '.shanhai', 'skills')

/**
 * 合法技能 id：字母/数字开头，其余只允许 `字母 数字 . _ -`，最长 64。
 * 这一条就同时挡掉了 `/`、`\`、空格、`..`（`.` 只允许出现在中间且由后续 `includes('..')` 再兜一层）、
 * 以及各种控制字符 —— 不做「去掉危险字符再继续」的净化（那等于尽力而为），一律直接拒绝。
 */
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 卸载一个**用户技能**（删除 `~/.shanhai/skills/<id>/` 整个目录）。破坏性操作，三道校验：
 *  1. id 合法性（正则 + 显式拒绝 `..`）；
 *  2. 该 id 必须来自 `SkillService.list()` 且 `source === 'user'`
 *     （内置 3 个技能是代码里写死的，磁盘上没有目录；此处拦截，不让界面绕过）；
 *  3. 路径夹取：解析后的绝对路径必须**严格位于** `~/.shanhai/skills/` 之内；
 *     再用 `realpath` 复核一次，防止 `~/.shanhai/skills/x` 是指向别处的符号链接。
 * 任何一步不过 → 返回 `{ok:false, error}`（界面必须显示出来），**不删任何东西**。
 * 成功后调 `refreshSkills()` 破 `SkillService.list()` 的实例缓存，否则列表还是旧的。
 */
export async function uninstallSkill(id: string): Promise<SkillUninstallResult> {
  const target = String(id ?? '').trim()
  if (!target) return { ok: false, error: '缺少技能 id' }
  if (!SKILL_ID_RE.test(target) || target.includes('..')) {
    return { ok: false, error: `非法技能 id：${target}` }
  }

  let skill: SkillSummary | undefined
  try {
    const all = await skillService.list()
    skill = all.map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source })).find((s) => s.id === target)
  } catch (err) {
    return { ok: false, error: `读取本机技能失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!skill) return { ok: false, error: `未找到技能：${target}` }
  if (skill.source !== 'user') return { ok: false, error: `内置技能不可卸载：${target}` }

  const rootResolved = resolvePath(SKILLS_DIR)
  const dir = resolvePath(rootResolved, target)
  if (dir === rootResolved || !dir.startsWith(rootResolved + sep)) {
    return { ok: false, error: `路径校验未通过：${target}` }
  }

  // realpath 复核：目录不存在 → 如实报「不存在」；存在但解析到根之外（符号链接逃逸）→ 拒绝
  let realRoot: string
  let realDir: string
  try {
    realRoot = await fs.realpath(rootResolved)
  } catch {
    return { ok: false, error: `技能目录不存在：${rootResolved}` }
  }
  try {
    realDir = await fs.realpath(dir)
  } catch {
    return { ok: false, error: `技能目录不存在：${target}` }
  }
  if (realDir === realRoot || !realDir.startsWith(realRoot + sep)) {
    return { ok: false, error: `路径校验未通过：${target}` }
  }

  try {
    // force:false —— 目录若在 realpath 之后被别处删掉，这里如实抛错而不是「静默成功」
    await fs.rm(dir, { recursive: true, force: false })
  } catch (err) {
    return { ok: false, error: `删除失败：${err instanceof Error ? err.message : String(err)}` }
  }

  refreshSkills()
  return { ok: true, id: target, dir }
}
