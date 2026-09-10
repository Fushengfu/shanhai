/**
 * 技能市场安装链路的**安全审计与元数据解析**（照抄 taco 的既有规则，见
 * /Volumes/data/code/views/taco/desktop/src/main/sdk/agent/skills/{security,frontmatter,install}.ts）。
 *
 * 为什么逐条移植而不是「简化版」：市场里的是**第三方代码**，其 SKILL.md 会被 AI 读取并据此执行
 * 命令、scripts/ 下的脚本可能被 AI 调用执行。审计规则一旦自创简化版，等于把风险闸门拆了。
 * 本文件与 taco 的差异只有两处（其余逐条对应）：
 *  1) 风险权重与阈值原样保留（>=15 critical / >=10 high / >=5 medium）；
 *  2) taco 的「本地目录源」审计分支（本地路径安装）本轮不做 —— 本轮只从两个远端市场装。
 *
 * 【本文件不做任何 IO 之外的决策】是否允许安装由调用方（skills-market.ts）按 riskLevel 决定。
 */

import { promises as fs } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/* ------------------------------------------------------------------ */
/*  元数据解析（SKILL.md 的 YAML frontmatter）                          */
/* ------------------------------------------------------------------ */

export interface ParsedSkillMeta {
  name?: string
  description?: string
  version?: string
  author?: string
  tools: string[]
  requiresBins: string[]
  requiresEnv: string[]
}

function leadingSpaces(line: string): number {
  const m = line.match(/^ */)
  return m ? m[0].length : 0
}

function stripQuotes(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

/** `[a, b]` 或 `a, b` → ['a','b']（frontmatter 里两种写法都常见） */
function parseInlineList(value: string): string[] {
  const t = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  return t
    .split(',')
    .map((s) => stripQuotes(s).trim())
    .filter(Boolean)
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))]
}

/** 收集 `key:` 之后缩进更深的所有行（返回时已剥掉父级缩进） */
function consumeIndentedBlock(lines: string[], start: number, parentIndent: number): { block: string[]; next: number } {
  const block: string[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed && leadingSpaces(line) <= parentIndent) break
    if (!trimmed) {
      i++
      continue
    }
    block.push(line.slice(Math.min(line.length, parentIndent + 2)))
    i++
  }
  return { block, next: i }
}

/**
 * 解析 SKILL.md 的 frontmatter。
 *
 * 支持三种常见写法（实测两个市场都存在）：
 *  - 扁平：`name: x` / `requires_bins: [a, b]`
 *  - 块状：`requires:` + 缩进的 `bins:` / `env:`
 *  - ClawHub 元数据：`metadata:` 块内再套 `requires:`（taco 专门为它写了分支）
 * 另外兼容 `# 标题` 兜底当 name（同 taco）。
 */
export function parseSkillMeta(content: string): ParsedSkillMeta {
  const meta: ParsedSkillMeta = { tools: [], requiresBins: [], requiresEnv: [] }
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (fm) parseFrontmatterBlock(fm[1] ?? '', meta)

  if (!meta.name) {
    const title = content.match(/^#\s+(.+)$/m)
    if (title) meta.name = (title[1] ?? '').trim().replace(/^Skill:\s*/i, '')
  }
  return meta
}

function parseFrontmatterBlock(block: string, out: ParsedSkillMeta): void {
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = leadingSpaces(raw)
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = (kv[1] ?? '').toLowerCase()
    const value = (kv[2] ?? '').trim()

    // 块状子结构
    if ((key === 'metadata' || key === 'requires' || key === 'tools') && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      const sub = consumed.block.join('\n')
      if (key === 'requires') mergeRequiresBlock(sub, out)
      else if (key === 'metadata') mergeRequiresBlock(sub, out) // clawhub：metadata 里内嵌 requires
      else out.tools = dedupe([...out.tools, ...parseListBlock(sub)])
      i = consumed.next - 1
      continue
    }

    if (key === 'name') out.name = stripQuotes(value)
    else if (key === 'description') out.description = stripQuotes(value)
    else if (key === 'version') out.version = stripQuotes(value)
    else if (key === 'author') out.author = stripQuotes(value)
    else if (key === 'requires_bins' || key === 'requires.bins') out.requiresBins = dedupe([...out.requiresBins, ...parseInlineList(value)])
    else if (key === 'requires_env' || key === 'requires.env') out.requiresEnv = dedupe([...out.requiresEnv, ...parseInlineList(value)])
    else if (key === 'tools' || key === 'allowed_tools') out.tools = dedupe([...out.tools, ...parseInlineList(value)])
  }

  // ClawHub 的 metadata 块里可能是 `requires:` 缩进（已被上面 merge），
  // 也可能直接是 `requires_bins:` 行（由 parseListBlock 兜住）
  if (out.requiresBins.length === 0) {
    const fm = block.match(/requires_bins\s*:\s*(.+)/i)
    if (fm) out.requiresBins = dedupe(parseInlineList(fm[1] ?? ''))
  }
  if (out.requiresEnv.length === 0) {
    const fm = block.match(/requires_env\s*:\s*(.+)/i)
    if (fm) out.requiresEnv = dedupe(parseInlineList(fm[1] ?? ''))
  }
}

/** 从块文本里抓 `bins:` / `env:` 两行（taco 的 parseRequiresBlock 简化后等价） */
function mergeRequiresBlock(block: string, out: ParsedSkillMeta): void {
  for (const line of block.split('\n')) {
    const m = line.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = (m[1] ?? '').toLowerCase()
    const value = (m[2] ?? '').trim()
    if (key === 'bins' || key === 'bin') out.requiresBins = dedupe([...out.requiresBins, ...parseInlineList(value)])
    else if (key === 'env' || key === 'environment') out.requiresEnv = dedupe([...out.requiresEnv, ...parseInlineList(value)])
  }
}

function parseListBlock(block: string): string[] {
  const out: string[] = []
  for (const line of block.split('\n')) {
    const t = line.trim().replace(/^-\s*/, '')
    if (t) out.push(stripQuotes(t))
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  安全审计                                                            */
/* ------------------------------------------------------------------ */

export interface SecurityCheck {
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  warnings: string[]
}

function levelOf(score: number): SecurityCheck['riskLevel'] {
  if (score >= 15) return 'critical'
  if (score >= 10) return 'high'
  if (score >= 5) return 'medium'
  return 'low'
}

/**
 * 审计 SKILL.md 正文 + frontmatter 声明的工具。
 * 规则与权重逐条照抄 taco 的 auditSkillSecurity，不做增删。
 */
export function auditSkillInstructions(instructions: string, meta: ParsedSkillMeta): SecurityCheck {
  const warnings: string[] = []
  let score = 0
  const text = instructions.toLowerCase()
  const combinedTools = [...meta.tools, ...meta.requiresBins].map((t) => t.toLowerCase())

  const dangerousCommands: { pattern: RegExp; weight: number; msg: string }[] = [
    { pattern: /rm\s+-rf|rm\s+-f|rm\s+-r\b(?!f)|rm\s+--recursive|rmdir\s+\/s|del\s+\/[sf]/g, weight: 10, msg: '包含强制删除命令' },
    { pattern: /chmod\s+[0-7]{3,4}|chown|icacls/g, weight: 8, msg: '包含权限修改命令' },
    { pattern: /sudo\s+|runas\s+/g, weight: 9, msg: '包含提权操作' },
    { pattern: /mkfs|fdisk|diskpart|format\s+/g, weight: 10, msg: '包含磁盘格式化命令' },
    { pattern: /curl\s.*\|.*sh|wget.*\|.*bash/g, weight: 10, msg: '包含管道执行网络脚本' },
    { pattern: /eval\s*\(|exec\s*\(/g, weight: 9, msg: '包含动态代码执行' },
  ]
  for (const { pattern, weight, msg } of dangerousCommands) {
    if (pattern.test(text)) {
      warnings.push(msg)
      score += weight
    }
  }

  const dangerousTools: Record<string, number> = { run_command: 5, delete_file: 6, write_file: 4, edit_file: 3 }
  for (const [tool, weight] of Object.entries(dangerousTools)) {
    if (combinedTools.includes(tool)) {
      warnings.push(`使用了高危工具: ${tool}`)
      score += weight
    }
  }

  const sensitivePaths: { pattern: RegExp; weight: number; msg: string }[] = [
    { pattern: /\/etc\/passwd|\/etc\/shadow/g, weight: 8, msg: '尝试访问系统敏感文件' },
    { pattern: /\.ssh\/|\.gitconfig|\.npmrc|\.pypirc/g, weight: 7, msg: '尝试访问凭证文件' },
    { pattern: /\/root\/|\/home\/[^/]+\/Documents/g, weight: 6, msg: '尝试访问用户私有目录' },
    { pattern: /node_modules\/.*\.env|\.env\.local/g, weight: 7, msg: '尝试访问环境变量文件' },
  ]
  for (const { pattern, weight, msg } of sensitivePaths) {
    if (pattern.test(text)) {
      warnings.push(msg)
      score += weight
    }
  }

  const networkPatterns: { pattern: RegExp; weight: number; msg: string }[] = [
    { pattern: /https?:\/\/[^\s]+/g, weight: 2, msg: '包含外部网络请求' },
    { pattern: /fetch\s*\(|axios\s*\(|request\s*\(/g, weight: 4, msg: '包含 HTTP 请求调用' },
  ]
  for (const { pattern, weight, msg } of networkPatterns) {
    if (pattern.test(text)) {
      warnings.push(msg)
      score += weight
    }
  }

  return { riskLevel: levelOf(score), warnings }
}

const AUDITABLE_SCRIPT_EXTS = new Set([
  '.sh', '.bash', '.zsh', '.fish',
  '.py', '.rb', '.pl', '.php',
  '.js', '.ts', '.mjs', '.cjs',
  '.go', '.rs',
  '.ps1', '.bat', '.cmd',
])

const MAX_SCRIPT_FILE_SIZE = 500 * 1024
const SCRIPT_AUDIT_SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build'])

function auditScriptContent(text: string): { warnings: string[]; score: number } {
  const warnings: string[] = []
  let score = 0
  const lower = text.toLowerCase()

  const dangerousCommands: { pattern: RegExp; weight: number; msg: string }[] = [
    { pattern: /rm\s+-rf|rm\s+-f|rm\s+-r\b(?!f)|rm\s+--recursive|rmdir\s+\/s|del\s+\/[sf]/g, weight: 10, msg: '脚本包含强制删除命令' },
    { pattern: /chmod\s+[0-7]{3,4}|chown|icacls/g, weight: 8, msg: '脚本包含权限修改命令' },
    { pattern: /sudo\s+|runas\s+/g, weight: 9, msg: '脚本包含提权操作' },
    { pattern: /mkfs|fdisk|diskpart|format\s+/g, weight: 10, msg: '脚本包含磁盘格式化命令' },
    { pattern: /curl\s.*\|.*(?:sh|bash|python|perl|ruby)|wget.*\|.*(?:sh|bash)/g, weight: 10, msg: '脚本包含管道执行远程代码' },
    { pattern: /eval\s*\(|exec\s*\(/g, weight: 9, msg: '脚本包含动态代码执行' },
    { pattern: /curl\s+.*-o\s+\S+\s*&&\s*(?:sh|bash|\.\/)/g, weight: 10, msg: '脚本下载并执行远程文件' },
    { pattern: /\bnc\s+-[lpe]|ncat\s+-[lpe]|netcat\s+-[lpe]/g, weight: 8, msg: '脚本包含网络监听/反向连接' },
    { pattern: />\s*\/dev\/tcp\/|>\s*\/dev\/udp\//g, weight: 10, msg: '脚本包含反弹 Shell' },
  ]
  for (const { pattern, weight, msg } of dangerousCommands) {
    if (pattern.test(lower)) {
      warnings.push(msg)
      score += weight
    }
  }

  const sensitivePaths: { pattern: RegExp; weight: number; msg: string }[] = [
    { pattern: /\/etc\/passwd|\/etc\/shadow/g, weight: 8, msg: '脚本访问系统敏感文件' },
    { pattern: /\.ssh\/|\.gitconfig|\.npmrc|\.pypirc|id_rsa|\.pem\b/g, weight: 7, msg: '脚本访问凭证/私钥文件' },
    { pattern: /\/root\/|\/home\/[^/]+\/(?:Documents|Desktop|Downloads)/g, weight: 6, msg: '脚本访问用户私有目录' },
    { pattern: /node_modules\/.*\.env|\.env\.local/g, weight: 7, msg: '脚本访问环境变量文件' },
    { pattern: /~\/\.aws\/|~\/\.config\/gcloud|\.kube\/config|docker\.sock/g, weight: 8, msg: '脚本访问云服务凭证' },
    { pattern: /\/(?:proc|sys)\//g, weight: 5, msg: '脚本访问系统运行时文件' },
  ]
  for (const { pattern, weight, msg } of sensitivePaths) {
    if (pattern.test(lower)) {
      warnings.push(msg)
      score += weight
    }
  }

  const networkPatterns: { pattern: RegExp; weight: number; msg: string }[] = [
    { pattern: /https?:\/\/[^\s]+/g, weight: 2, msg: '脚本包含外部网络请求' },
    { pattern: /fetch\s*\(|axios\s*\(|request\s*\(/g, weight: 4, msg: '脚本包含 HTTP 请求调用' },
  ]
  for (const { pattern, weight, msg } of networkPatterns) {
    if (pattern.test(lower)) {
      warnings.push(msg)
      score += weight
    }
  }

  const envMatches = lower.match(/\$\([^)]+\)|`[^`]+`/g)
  if (envMatches && envMatches.length > 0) {
    warnings.push(`脚本包含命令替换（${envMatches.length} 处）`)
    score += 15
  }

  return { warnings, score }
}

/**
 * 递归审计技能目录下 `scripts/` 里的文本脚本（不跟符号链接、跳过二进制与超大文件）。
 * 目录不存在 = 无脚本可审（低风险），与 taco 一致。
 */
export async function auditScriptFiles(skillDir: string): Promise<SecurityCheck> {
  const scriptsDir = join(skillDir, 'scripts')
  try {
    await fs.access(scriptsDir)
  } catch {
    return { riskLevel: 'low', warnings: [] }
  }

  const warnings: string[] = []
  let score = 0
  const queue: string[] = [scriptsDir]

  while (queue.length > 0) {
    const dir = queue.shift() as string
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SCRIPT_AUDIT_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full)
        continue
      }
      if (entry.isSymbolicLink()) {
        warnings.push(`脚本目录包含符号链接: ${relative(scriptsDir, full)}`)
        score += 8
        continue
      }
      if (!AUDITABLE_SCRIPT_EXTS.has(extname(entry.name))) continue

      let size = 0
      try {
        size = (await fs.stat(full)).size
      } catch {
        continue
      }
      if (size > MAX_SCRIPT_FILE_SIZE) {
        warnings.push(`脚本文件过大（${(size / 1024).toFixed(0)}KB），跳过审计: ${relative(scriptsDir, full)}`)
        continue
      }
      let content = ''
      try {
        content = await fs.readFile(full, 'utf-8')
      } catch {
        continue
      }
      const r = auditScriptContent(content)
      if (r.warnings.length > 0) {
        for (const w of r.warnings) warnings.push(`[${relative(scriptsDir, full)}] ${w}`)
        score += r.score
      }
    }
  }

  return { riskLevel: levelOf(score), warnings }
}

function extname(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

const LEVEL_SCORE: Record<SecurityCheck['riskLevel'], number> = { low: 0, medium: 5, high: 10, critical: 15 }

/** 合并「SKILL.md 审计」与「scripts 审计」（taco mergeSecurityChecks 的等价实现） */
export function mergeSecurity(a: SecurityCheck, b: SecurityCheck): SecurityCheck {
  return {
    riskLevel: levelOf(LEVEL_SCORE[a.riskLevel] + LEVEL_SCORE[b.riskLevel]),
    warnings: [...a.warnings, ...b.warnings],
  }
}

/* ------------------------------------------------------------------ */
/*  解压防护                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解压**前**校验压缩包内的条目名（ZIP slip 防护的前半）：
 * 拒绝绝对路径、`..` 段、盘符、反斜杠路径、以及空名。
 * 必须在 `unzip` 落盘之前跑 —— 一旦解压出去，写到 dest 之外的字节就先落盘了。
 */
export function validateArchiveNames(names: string[]): void {
  for (const raw of names) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
      throw new Error(`安全风险：ZIP 含绝对路径 "${name}"，已拒绝`)
    }
    if (name.includes('\\')) {
      throw new Error(`安全风险：ZIP 含反斜杠路径 "${name}"，已拒绝`)
    }
    const parts = name.split('/')
    if (parts.includes('..')) {
      throw new Error(`安全风险：ZIP 含越界路径 "${name}"，已拒绝`)
    }
  }
}

/**
 * 解压**后**校验落盘树（ZIP slip 防护的后半）：
 * 拒绝符号链接、拒绝任何 resolve 之后跑到 root 之外的路径。
 */
export async function validateExtractionTree(dir: string): Promise<void> {
  const root = resolve(dir)
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = resolve(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`安全风险：ZIP 包含符号链接 "${entry.name}"，已拒绝`)
      }
      if (full !== root && !full.startsWith(root + sep)) {
        throw new Error(`安全风险：ZIP 包含越界路径 "${full}"，已拒绝`)
      }
      if (entry.isDirectory()) await walk(full)
    }
  }
  await walk(root)
}

/** 递归列出目录下的全部文件（相对路径，正斜杠分隔），用于安装结果反馈 */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  await walk(dir)
  out.sort()
  return out
}
