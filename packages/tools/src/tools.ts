import { promises as fs } from 'node:fs'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, isAbsolute, join, relative } from 'node:path'

const execFile = promisify(execFileCallback)

/** run_command 命令执行超时（毫秒）：超时后 kill 子进程并返回错误，防止命令永久卡死堵塞任务循环（等机器类的兜底，区别于 ask_user 等「等用户」工具的不超时） */
const RUN_COMMAND_TIMEOUT_MS = 5 * 60 * 1000

/** 工具风险等级（安全属性内嵌于契约） */
export type RiskLevel = 'readonly' | 'reversible' | 'irreversible' | 'high'

/**
 * 工具使用手册：usage = 使用规则（何时用 / 怎么用 / 推荐流程 / 参数建议），
 * cautions = 注意事项（陷阱 / 禁止项 / 高频错误）。
 *
 * 对齐 taco 的 TOOL_GUIDE_MANUAL：每个工具就近维护自己的手册，
 * 运行时由 buildToolGuidePrompt 拼装进系统提示词的「工具使用手册」块。
 * description 承载的是「参数 schema 里就表达得了」的简短说明，而 guide 承载的是
 * schema 表达不了的「用法 / 协作顺序 / 陷阱」——这正是模型仅靠 function schema 学不会的部分。
 */
export interface ToolGuide {
  usage?: string[]
  cautions?: string[]
}

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
  /** 单工具执行超时（毫秒）。Infinity = 不设超时（等用户交互的工具，如 ask_user / choose_session / choose_model——用户思考/离开多久由用户决定）。
   *  未设置时 agent 用默认兜底（5 分钟），防止网络/进程/IO 类工具永久挂起卡死整个任务循环。 */
  timeoutMs?: number
  /** 工具使用手册：运行时由 buildToolGuidePrompt 拼装进系统提示词的「工具使用手册」块。
   *  缺省时该工具仅靠 description（通过 function schema 传给模型），不生成手册条目。 */
  guide?: ToolGuide
  /** 动态风险解析：统一入口工具（如 skill_run）按 args 决定审批粒度（action 级）。
   *  返回 undefined 则回退到静态 riskLevel / approvalRequired。
   *  outsideWorkdir：本次操作是否访问工作目录之外（供「工作目录内免审批」安全模式按范围决定是否弹窗）。 */
  resolveRisk?: (
    args: Record<string, unknown>,
  ) =>
    | { riskLevel: RiskLevel; approvalRequired?: boolean; outsideWorkdir?: boolean }
    | Promise<{ riskLevel: RiskLevel; approvalRequired?: boolean; outsideWorkdir?: boolean }>
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
 * —— 命令执行环境变量注入（参考 Taco 设计）——
 * 桌面 GUI 应用从 Finder 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * 缺少 Homebrew(/opt/homebrew/bin)、nvm、pnpm 等路径，导致执行命令时报「命令不存在」。
 * 这里启动一次用户登录 shell 提取完整环境（含 .zshrc/.zprofile 里配的 PATH），
 * 与当前进程环境合并后缓存复用，run_command 执行命令时注入该完整环境。
 */

/** 解析 `env -0` 输出的 NUL 分隔 key=value */
function parseNulSeparatedEnv(raw: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const item of raw.split('\0')) {
    if (!item) continue
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    env[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return env
}

/** 合并 PATH：primary 优先、secondary 兜底，去重（Windows 用 ';' 分隔且忽略大小写） */
function mergePathValue(primary: string, secondary: string): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const normalize = (p: string) =>
    process.platform === 'win32' ? p.toLowerCase().replace(/[/\\]+$/, '') : p
  const seen = new Set<string>()
  const merged: string[] = []
  for (const raw of `${primary}${sep}${secondary}`.split(sep)) {
    const p = raw.trim()
    if (!p) continue
    const key = normalize(p)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(p)
  }
  return merged.join(sep)
}

/** 启动用户登录 shell 提取完整环境变量；先交互登录 shell，失败降级登录 shell，再失败返回空 */
async function loadLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return {}
  const shell = process.env.SHELL || '/bin/zsh'
  const attempts: Array<{ args: string[] }> = [
    { args: ['-ilc', 'env -0'] },
    { args: ['-lc', 'env -0'] },
  ]
  for (const attempt of attempts) {
    try {
      const { stdout } = await execFile(shell, attempt.args, {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env },
      })
      const parsed = parseNulSeparatedEnv(stdout)
      if (Object.keys(parsed).length > 0) return parsed
    } catch {
      // 忽略，尝试下一种方式
    }
  }
  return {}
}

/** 命令执行环境缓存：完整环境只在首次加载一次，之后复用，避免每条命令都起 shell 拖慢执行 */
let commandEnvCache: NodeJS.ProcessEnv | null = null
let commandEnvLoadingPromise: Promise<NodeJS.ProcessEnv> | null = null

/** 获取 run_command 的执行环境：系统环境 + 登录 shell 环境合并，PATH 用登录 shell 优先去重 */
async function getRunCommandEnv(): Promise<NodeJS.ProcessEnv> {
  if (commandEnvCache) return commandEnvCache
  if (commandEnvLoadingPromise) return commandEnvLoadingPromise
  commandEnvLoadingPromise = (async () => {
    const systemEnv: NodeJS.ProcessEnv = { ...process.env }
    const shellEnv = await loadLoginShellEnv()
    const merged: NodeJS.ProcessEnv = { ...systemEnv, ...shellEnv }
    const shellPath = shellEnv.PATH || shellEnv.Path
    const systemPath = systemEnv.PATH || systemEnv.Path
    if (shellPath && systemPath) {
      const pathValue = mergePathValue(shellPath, systemPath)
      merged.PATH = pathValue
      merged.Path = pathValue
    }
    commandEnvCache = merged
    return merged
  })()
  try {
    return await commandEnvLoadingPromise
  } finally {
    commandEnvLoadingPromise = null
  }
}

/** run_command 输出缓冲上限（字节）：超出则判定命令产出异常（如死循环打印），终止进程组并报错，避免内存无界增长。 */
const RUN_COMMAND_MAX_BUFFER = 10 * 1024 * 1024

/**
 * 执行 shell 命令，带「进程组级」超时与输出上限保护。
 *
 * 与 `exec(command, { timeout })` 的关键区别：exec 的 timeout 只向 shell 进程发 SIGTERM，
 * shell 被 kill 后其派生的子进程（sleep / npm / node 等）会变成孤儿进程继续跑、残留不回收；
 * 且这些孤儿进程仍持有 stdout/stderr 管道写端，管道不关闭。这里改用 spawn + detached（POSIX 进程组），
 * 超时/超限时 `kill(-pid)` 杀整个进程组（shell + 全部子/孙进程），确保进程树被干净回收、promise 正常 settle。
 */
function runCommandWithTimeout(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; shell: string; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // detached: true（POSIX）让 shell 成为新进程组组长，超时后 kill(-pid) 能杀整组。
    // Windows 无进程组语义，用 taskkill /T（树）兜底。
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let overflow = false

    const killTree = (): void => {
      try {
        if (process.platform === 'win32') {
          // /T 杀整棵进程树，/F 强制
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          // 负 pid = 进程组（含 shell 与其所有子进程）；SIGKILL 兜底（SIGTERM 可能被忽略）
          process.kill(-child.pid!, 'SIGKILL')
        }
      } catch {
        // 进程组可能已退出
      }
    }

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      if (settled) return
      killTree()
      settle(() => reject(new Error(`命令执行超时（${Math.round(opts.timeout / 1000)}s），已终止整个进程组`)))
    }, opts.timeout)

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (!overflow && stdout.length + stderr.length > RUN_COMMAND_MAX_BUFFER) {
        overflow = true
        killTree()
        settle(() => reject(new Error(`命令输出超过上限（${RUN_COMMAND_MAX_BUFFER / 1024 / 1024}MB），已终止进程组`)))
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (!overflow && stdout.length + stderr.length > RUN_COMMAND_MAX_BUFFER) {
        overflow = true
        killTree()
        settle(() => reject(new Error(`命令输出超过上限（${RUN_COMMAND_MAX_BUFFER / 1024 / 1024}MB），已终止进程组`)))
      }
    })
    child.on('error', (err) => settle(() => reject(err)))
    child.on('close', (code, signal) => settle(() => resolve({ stdout, stderr })))
  })
}

/**
 * 创建内置原子工具清单。所有文件/命令操作都围绕 `getCwd()` 返回的会话工作目录：
 * 相对路径解析到工作目录下，命令也以工作目录为 cwd 执行——保证「工具围绕当前工作目录」这一约束。
 * `snapshot` 为写前快照回调（可选）：注入后 write_file 在覆盖已有文件前自动备份，支撑「信任四可」的可回退。
 */
export function createAtomicTools(getCwd: () => string, snapshot?: SnapshotFn): ToolContract[] {
  const resolvePath: PathResolver = (p) => {
    if (isAbsolute(p)) return p
    const resolved = resolve(getCwd(), p)
    // 路径穿越防护：相对路径解析后越界（../ 逃逸工作目录）时抛错，强制改用绝对路径显式访问外部文件。
    // 绝对路径不拦截——agent 读取/写入用户指定目录外文件是显式意图，由审批层（write/run）兜底。
    if (relative(getCwd(), resolved).startsWith('..')) {
      throw new Error(`路径越界：相对路径 "${p}" 解析后超出工作目录，请改用绝对路径明确访问`)
    }
    return resolved
  }

  /** 判断绝对路径是否落在工作目录之外（只读工具用绝对路径显式访问目录外文件时需审批确认） */
  const isOutsideWorkdir = (p: string): boolean => {
    const rel = relative(getCwd(), resolve(p))
    return rel.startsWith('..') || isAbsolute(rel)
  }

  /** 只读文件/目录工具的动态审批：仅当用绝对路径显式访问工作目录之外时，要求用户确认（相对路径永远在目录内，且越界已被 resolvePath 拦截）。
   *  outsideWorkdir 供「工作目录内免审批」模式判断：相对路径视为目录内，绝对路径按是否越界判断。 */
  const readonlyPathResolveRisk = (
    args: Record<string, unknown>,
  ): { riskLevel: RiskLevel; approvalRequired: boolean; outsideWorkdir: boolean } => {
    const raw = typeof args.path === 'string' ? args.path.trim() : ''
    if (!raw) return { riskLevel: 'readonly', approvalRequired: false, outsideWorkdir: false }
    const outside = isAbsolute(raw) && isOutsideWorkdir(raw)
    return { riskLevel: 'readonly', approvalRequired: outside, outsideWorkdir: outside }
  }

  /** 文件写/编辑工具的动态审批：静态风险保持 reversible + 全量审批（ask 模式不变），
   *  额外返回 outsideWorkdir 供「工作目录内免审批」模式按范围决定是否免审批。 */
  const fileWriteScopeRisk = (
    args: Record<string, unknown>,
  ): { riskLevel: RiskLevel; approvalRequired: boolean; outsideWorkdir: boolean } => {
    const raw = typeof args.path === 'string' ? args.path.trim() : ''
    const outside = !!raw && isAbsolute(raw) && isOutsideWorkdir(raw)
    return { riskLevel: 'reversible', approvalRequired: true, outsideWorkdir: outside }
  }

  /** 命令是否可能访问工作目录之外（越界信号近似检测：cd 切换目录 / 绝对路径 / 家目录 ~ / 父目录 ..）。
   *  这是保守近似——命令副作用范围无法静态精确判定，命中越界信号则在「工作目录内免审批」模式下仍审批。 */
  const commandLooksOutsideWorkdir = (cmd: string): boolean => {
    if (/\bcd\s+/.test(cmd)) return true
    if (/(^|[^\w$])\/\S/.test(cmd)) return true
    if (/~/.test(cmd)) return true
    if (/(^|[^\w$])\.\.(\/|$)/.test(cmd)) return true
    return false
  }

  /** 解析行号参数：接受 number 或可转数字的字符串，非法返回 undefined */
  const toLineNumber = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return undefined
  }

  /** read_file 默认分段读取行数（最小/默认粒度）：未指定 endLine 时每次默认读取 1000 行，避免大文件一次返回全文撑爆上下文 */
  const READ_FILE_DEFAULT_LINES = 1000
  /** read_file 单次读取最大行数上限：超出自动截断并提示，避免一次读取过多撑爆上下文 */
  const READ_FILE_MAX_LINES = 2000

  /** read_file：读取文件内容（相对路径解析到工作目录，默认分段读取：最少 1000 行、单次最多 2000 行，避免大文件一次返回全文撑爆上下文） */
  const readFileTool: ToolContract = {
    name: 'read_file',
    description:
      '读取指定路径的文本文件内容。当需要查看文件内容时使用。' +
      'path 可以是绝对路径，也可以是相对于当前工作目录的相对路径（优先使用相对路径，保持操作范围在工作目录内）。' +
      '按行分段读取：未指定行号时每次最少读取 1000 行（文件不足 1000 行则读全文），单次最多读取 2000 行，截断时会提示总行数与继续读取的 startLine。' +
      '可用 startLine / endLine 精确指定行范围（1-based、包含两端），范围超过单次上限 2000 行时自动截断并提示。' +
      '注意：避免连续使用相同参数调用此工具，以免造成重复读取。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径，或相对当前工作目录的相对路径）' },
        startLine: { type: 'number', description: '起始行号（1-based，包含，可选；不传默认从第 1 行开始）' },
        endLine: { type: 'number', description: '结束行号（1-based，包含，可选；不传默认读取 200 行；单次最多读取 1000 行，超出自动截断）' },
      },
      required: ['path'],
    },
    riskLevel: 'readonly',
    resolveRisk: readonlyPathResolveRisk,
    guide: {
      usage: [
        '读取策略按文件大小智能选择：小文件（<1000 行）直接全文读取，不指定 startLine/endLine；大文件（>=1000 行）按行范围读取，每次至少读取 1000 行。',
        '禁止 200-300 行的小块连续读取；需要读取大文件的多个区段时，合并为单次大范围读取（如 startLine=1, endLine=2000），而非多次小范围调用。',
        '需要全局理解文件结构、查找跨区段引用、或文件被用户手动附加时，优先全文读取。',
        '仅当明确知道目标代码所在行号范围（如修改某个具体函数）时，才使用精确的行范围读取。',
        '注意：避免连续使用相同参数调用此工具，以免造成重复读取。',
      ],
      cautions: [
        '小文件禁止分块读取，直接全文读取更高效。',
        '大文件读取时单次范围过小会导致多次往返调用，显著降低效率。',
        '工作空间外文件读取属于高风险动作，必须等待用户授权确认后才能继续。',
      ],
    },
    execute: async (args) => {
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        throw new Error('read_file 缺少 path 参数：请提供要读取的文件路径（相对或绝对路径）')
      }
      const path = resolvePath(args.path)
      const text = await fs.readFile(path, 'utf8')
      const lines = text.split('\n')
      const total = lines.length
      const startLine = toLineNumber(args.startLine)
      const endLine = toLineNumber(args.endLine)
      // 明确指定 endLine → 按精确范围读取，但单次最多读取 1000 行（超出截断并提示继续）
      if (endLine !== undefined) {
        const start = Math.max(1, Math.floor(startLine ?? 1))
        const requestedEnd = Math.floor(endLine)
        if (start > requestedEnd) {
          throw new Error(`read_file 行范围非法：startLine=${start} 大于 endLine=${requestedEnd}`)
        }
        const end = Math.min(requestedEnd, start + READ_FILE_MAX_LINES - 1)
        const content = lines.slice(start - 1, end).join('\n')
        if (end < requestedEnd) {
          return `${content}\n\n（单次最多读取 ${READ_FILE_MAX_LINES} 行，本次读取 ${start}-${end} 行，剩余 ${requestedEnd - end} 行未读。请用 startLine=${end + 1} 继续分段读取。）`
        }
        return content
      }
      // 未指定 endLine → 默认分段读取 1000 行（不足则到文件末尾），截断时提示继续读取
      const start = Math.max(1, Math.floor(startLine ?? 1))
      const end = Math.min(start + READ_FILE_DEFAULT_LINES - 1, total)
      if (start > end) {
        throw new Error(`read_file 行范围非法：startLine=${start} 大于 endLine=${end}`)
      }
      const content = lines.slice(start - 1, end).join('\n')
      // 截断提示：未读完整时，告知总行数与继续读取的起始行，引导模型分段读取后续内容
      if (end < total) {
        return `${content}\n\n（文件共 ${total} 行，本次读取 ${start}-${end} 行，剩余 ${total - end} 行未读。请用 startLine=${end + 1} 继续分段读取。）`
      }
      return content
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
    resolveRisk: fileWriteScopeRisk,
    guide: {
      usage: [
        '仅在需要重写整个文件时使用；局部变更优先用 edit_file（token 开销小）。',
        '写入前先 read_file 确认目标文件当前结构，避免覆盖无关内容。',
        '写入后回读关键片段验证落盘结果。',
      ],
      cautions: [
        '严禁在未确认路径和内容时覆盖核心文件。',
        '内容过大时不要一次性 write_file 重写整个大文件，优先 edit_file 局部改动。',
      ],
    },
    execute: async (args) => {
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        throw new Error('write_file 缺少 path 参数：请提供要写入的文件路径（相对或绝对路径）')
      }
      const path = resolvePath(args.path)
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

  /** edit_file：编辑已有文件（替换模式，仅需提供被替换片段与新片段，token 开销小，避免重传全文） */
  const editFileTool: ToolContract = {
    name: 'edit_file',
    description:
      '编辑已有文件：将 oldText 精确替换为 newText（替换模式，只需提供要改的片段，无需重传全文，token 开销小）。' +
      'path 可以是绝对路径，也可以是相对于当前工作目录的相对路径。' +
      '默认只替换首次命中；当 oldText 在文件中出现多次时，需设置 replaceAll=true 替换全部，或提供更长的 oldText 上下文精确定位唯一命中；' +
      '也可设置 expectedOccurrences 声明期望命中次数，实际命中不符则报错。修改文件默认需用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径，或相对当前工作目录的相对路径）' },
        oldText: { type: 'string', description: '需要被替换的原文本（必须精确匹配）' },
        newText: { type: 'string', description: '替换后的新文本' },
        replaceAll: { type: 'boolean', description: '是否替换全部命中，默认 false（只替换首个命中）' },
        expectedOccurrences: { type: 'number', description: '期望 oldText 出现的次数，实际不符则报错（可选）' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    riskLevel: 'reversible',
    approvalRequired: true,
    resolveRisk: fileWriteScopeRisk,
    guide: {
      usage: [
        '先 read_file 定位并确认 oldText 与上下文完全一致后再替换。',
        '默认只替换首个命中；多处命中场景需显式设置 replaceAll=true 或 expectedOccurrences。',
        '替换后再次 read_file 校验函数/变量/语法是否保持正确。',
      ],
      cautions: [
        '避免使用过短 oldText，防止误改到非目标位置。',
        'oldText 未命中会直接报错，替换前务必用 read_file 拿到文件的真实当前内容（含空格/缩进/换行）。',
      ],
    },
    execute: async (args) => {
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        throw new Error('edit_file 缺少 path 参数：请提供要修改的文件路径（相对或绝对路径）')
      }
      if (typeof args.oldText !== 'string' || args.oldText === '') {
        throw new Error('edit_file 缺少 oldText 参数：请提供要被替换的原文本片段')
      }
      const path = resolvePath(args.path)
      const oldText = args.oldText
      const newText = String(args.newText ?? '')
      const replaceAll = args.replaceAll === true
      const expectedOccurrences = typeof args.expectedOccurrences === 'number' ? args.expectedOccurrences : undefined

      let before: string
      try {
        before = await fs.readFile(path, 'utf8')
      } catch {
        throw new Error(`edit_file 读取文件失败：${path} 不存在或无法读取`)
      }

      // 命中次数 = split 后段数 - 1（split/join 不做正则替换模式解析，避免 $ 等特殊字符被误解）
      const count = before.split(oldText).length - 1
      if (count === 0) {
        throw new Error('edit_file 未找到 oldText：文件中不存在该文本片段，请先用 read_file 读取实际内容，确保 oldText 精确匹配')
      }
      if (expectedOccurrences !== undefined && count !== expectedOccurrences) {
        throw new Error(`edit_file 命中次数不匹配：期望 ${expectedOccurrences} 处，实际 ${count} 处`)
      }
      if (!replaceAll && count > 1) {
        throw new Error(`edit_file 命中 ${count} 处：请提供更长的 oldText 上下文精确定位唯一命中，或设置 replaceAll=true 替换全部`)
      }

      const after = replaceAll
        ? before.split(oldText).join(newText)
        : before.slice(0, before.indexOf(oldText)) + newText + before.slice(before.indexOf(oldText) + oldText.length)

      // 写前快照：备份原文件，支撑回滚
      let snapshotId: string | undefined
      if (snapshot) {
        try {
          snapshotId = (await snapshot(path))?.snapshotId
        } catch {
          snapshotId = undefined
        }
      }
      await fs.writeFile(path, after, 'utf8')
      return { ok: true, path, occurrences: replaceAll ? count : 1, before, after, snapshotId }
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
    resolveRisk: (args): { riskLevel: RiskLevel; approvalRequired: boolean; outsideWorkdir: boolean } => {
      const cmd = typeof args.command === 'string' ? args.command : ''
      return { riskLevel: 'irreversible', approvalRequired: true, outsideWorkdir: commandLooksOutsideWorkdir(cmd) }
    },
    guide: {
      usage: [
        '用于构建、测试、运行和验证真实结果，优先执行最小必要命令。',
        '明确设置 cwd 到目标项目目录（run_command 参数无 cwd 时默认当前工作目录），避免在错误目录执行。',
        '代码搜索默认优先使用 grep（grep -rn "关键字" 递归搜索并显示行号），而非逐文件 read_file。',
        '搜索不到时拆分关键词、扩大搜索范围再试，最后才 read_file 整文件。',
      ],
      cautions: [
        '命令失败时返回关键 stdout/stderr，并给出下一步处理动作。',
        '未获用户明确授权时，禁止执行高风险破坏性命令（rm -rf、sudo 等）。',
        '命令可能永久卡死时避免使用交互式命令，优先用非交互方式或加超时。',
      ],
    },
    execute: async (args) => {
      if (typeof args.command !== 'string' || args.command.trim() === '') {
        throw new Error('run_command 缺少 command 参数：请提供要执行的 shell 命令')
      }
      // 注入完整环境变量（含登录 shell 的 PATH），避免 GUI 启动的精简 PATH 导致「命令不存在」
      const env = await getRunCommandEnv()
      // 显式指定 shell（等价于 Node 默认，但明确平台分支，便于后续扩展 Git Bash 兼容）：
      //   win32 用 ComSpec/cmd.exe（支持 &&、|、> 等），POSIX 用 /bin/sh。agent 在 Windows 上应写 cmd 兼容命令。
      const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
      return runCommandWithTimeout(args.command, { cwd: getCwd(), env, shell, timeout: RUN_COMMAND_TIMEOUT_MS })
    },
  }

  /** list_dir：树形列出目录（只读；访问工作目录外目录时需审批确认） */
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
    resolveRisk: readonlyPathResolveRisk,
    guide: {
      usage: [
        '用于快速理解目录结构，优先以较小 maxDepth 查看骨架，再决定深入哪一层。',
        '定位目标后配合 read_file 深入读取具体文件；内容搜索统一优先 run_command + grep。',
      ],
      cautions: [
        '避免反复列举深层大目录，噪声大且费 token；先 list_dir 看骨架、再用 read_file 精读目标文件。',
        '默认跳过隐藏文件、node_modules、dist，找不到目标时用 run_command + grep 按文件名/内容搜索。',
      ],
    },
    execute: async (args) => {
      const raw = args.path ? String(args.path) : ''
      const dir = raw ? resolvePath(raw) : getCwd()
      const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 3
      return buildDirTree(dir, maxDepth, 300)
    },
  }

  return [readFileTool, writeFileTool, editFileTool, runCommandTool, listDirTool]
}

/**
 * 拼装工具使用手册块：把每个工具就近维护的 guide（usage / cautions）组合成结构化提示词。
 *
 * 只输出「带 guide 且至少有 usage 或 cautions 之一」的工具——description 已通过 function schema
 * 传给模型（见 @shanhai/llm 的 serializeTools），这里只补 schema 表达不了的「用法 / 协作顺序 / 陷阱」，
 * 避免在系统提示词里重复 description 白白烧 token。
 * 返回空字符串表示没有任何工具带手册，调用方据此跳过该块。
 */
export function buildToolGuidePrompt(tools: ToolContract[]): string {
  const blocks: string[] = ['## 工具清单（每个工具都要遵守对应规范）']
  for (const t of tools) {
    const g = t.guide
    if (!g) continue
    const usage = g.usage && g.usage.length > 0 ? g.usage.map((u, i) => `${i + 1}. ${u}`).join('\n') : undefined
    const cautions = g.cautions && g.cautions.length > 0 ? g.cautions.map((c) => `- ${c}`).join('\n') : undefined
    if (!usage && !cautions) continue
    const lines = [`### ${t.name}`]
    if (usage) lines.push('使用规则：', usage)
    if (cautions) lines.push('注意事项：', cautions)
    blocks.push(lines.join('\n'))
  }
  return blocks.length > 0 ? blocks.join('\n') : ''
}
