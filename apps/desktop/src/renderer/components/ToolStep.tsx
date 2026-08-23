import { useState } from 'react'
import type { ToolTrace } from '../types'
import { IconActivity, IconAvatar, IconChevronDown, IconClock, IconCode, IconEdit, IconFile, IconGlobe, IconImage, IconMonitor, IconPlus, IconRefresh, IconSend, IconShield, IconTerminal, IconTrash, IconTree, IconUsers, IconWrench } from './icons'
import { redactSecret, stringifyResult, truncate } from './ui'

// ===== 工具调用渲染（参考 DSH ToolRow / Codex：单行摘要 + 类型卡片，不显示 JSON）=====

/** 已有专门交互 UI 的机制类工具：不在聊天流里以「工具步骤」卡片形式显示（避免暴露内部工具名 + 与专用卡片重复展示） */
const HIDDEN_STEP_TOOLS = new Set(['ask_user'])

/** 工具名 → 人类可读的中文标题 + 图标（原始工具名对普通人不可读） */
export const TOOL_META: Record<string, { title: string; icon: React.ReactNode }> = {
  read_file: { title: '读取文件', icon: <IconFile /> },
  write_file: { title: '写入文件', icon: <IconEdit /> },
  edit_file: { title: '编辑文件', icon: <IconEdit /> },
  run_command: { title: '执行命令', icon: <IconTerminal /> },
  list_dir: { title: '列出目录', icon: <IconTree /> },
  image_analyze: { title: '识别图片', icon: <IconImage /> },
  computer_screenshot: { title: '屏幕截图', icon: <IconMonitor /> },
  computer_ocr: { title: '文字识别', icon: <IconMonitor /> },
  computer_action: { title: '电脑操作', icon: <IconMonitor /> },
  browser_create: { title: '创建浏览器窗口', icon: <IconGlobe /> },
  browser_list: { title: '列出浏览器窗口', icon: <IconGlobe /> },
  browser_navigate: { title: '打开网页', icon: <IconGlobe /> },
  browser_close: { title: '关闭浏览器窗口', icon: <IconGlobe /> },
  browser_screenshot: { title: '网页截图', icon: <IconGlobe /> },
  browser_get_info: { title: '读取页面信息', icon: <IconGlobe /> },
  browser_get_content: { title: '读取页面内容', icon: <IconGlobe /> },
  browser_evaluate: { title: '执行页面脚本', icon: <IconGlobe /> },
  browser_click: { title: '点击页面元素', icon: <IconGlobe /> },
  browser_type: { title: '页面输入', icon: <IconGlobe /> },
  browser_scroll: { title: '滚动页面', icon: <IconGlobe /> },
  browser_wait: { title: '等待元素', icon: <IconGlobe /> },
  browser_get_console_logs: { title: '查看控制台日志', icon: <IconGlobe /> },
  browser_get_network_requests: { title: '查看网络请求', icon: <IconGlobe /> },
  browser_get_cookies: { title: '读取 Cookie', icon: <IconGlobe /> },
  browser_set_cookie: { title: '设置 Cookie', icon: <IconGlobe /> },
  browser_clear_cookies: { title: '清除 Cookie', icon: <IconGlobe /> },
  rollback_file: { title: '回滚文件', icon: <IconEdit /> },
  remember: { title: '保存记忆', icon: <IconClock /> },
  recall_memory: { title: '召回记忆', icon: <IconClock /> },
  plugin_inspect: { title: '查看自修改', icon: <IconCode /> },
  plugin_define: { title: '定义动态包', icon: <IconCode /> },
  plugin_run: { title: '运行动态包', icon: <IconCode /> },
  plugin_stop: { title: '停止动态包', icon: <IconCode /> },
  plugin_undefine: { title: '删除动态包', icon: <IconCode /> },
  // 会话管家（主 Agent）专属工具：用于审批弹窗展示可读名称，避免暴露英文原始名
  list_sessions: { title: '查看会话列表', icon: <IconUsers /> },
  inspect_session: { title: '查看会话详情', icon: <IconUsers /> },
  list_models: { title: '查看可用模型', icon: <IconActivity /> },
  switch_session: { title: '切换激活会话', icon: <IconRefresh /> },
  send_message: { title: '给会话下发任务', icon: <IconSend /> },
  inject_message: { title: '给会话追加需求', icon: <IconSend /> },
  set_session_model: { title: '切换会话模型', icon: <IconActivity /> },
  set_session_approval: { title: '配置会话安全模式', icon: <IconShield /> },
  create_session: { title: '新建会话', icon: <IconPlus /> },
  rename_session: { title: '重命名会话', icon: <IconEdit /> },
  delete_session: { title: '删除会话', icon: <IconTrash /> },
}

/** skill_run（可执行技能统一入口）的 skillId + action → 中文标题 + 图标 */
function skillActionMeta(skillId: string, action: string): { title: string; icon: React.ReactNode } {
  const map: Record<string, { title: string; icon: React.ReactNode }> = {
    'computer-use:screenshot': { title: '屏幕截图', icon: <IconMonitor /> },
    'computer-use:ocr': { title: '文字识别', icon: <IconMonitor /> },
    'computer-use:action': { title: '电脑操作', icon: <IconMonitor /> },
    'browser-use:create': { title: '创建浏览器窗口', icon: <IconGlobe /> },
    'browser-use:list': { title: '列出浏览器窗口', icon: <IconGlobe /> },
    'browser-use:navigate': { title: '打开网页', icon: <IconGlobe /> },
    'browser-use:close': { title: '关闭浏览器窗口', icon: <IconGlobe /> },
    'browser-use:screenshot': { title: '网页截图', icon: <IconGlobe /> },
    'browser-use:get_info': { title: '读取页面信息', icon: <IconGlobe /> },
    'browser-use:get_content': { title: '读取页面内容', icon: <IconGlobe /> },
    'browser-use:evaluate': { title: '执行页面脚本', icon: <IconGlobe /> },
    'browser-use:click': { title: '点击页面元素', icon: <IconGlobe /> },
    'browser-use:type': { title: '页面输入', icon: <IconGlobe /> },
    'browser-use:scroll': { title: '滚动页面', icon: <IconGlobe /> },
    'browser-use:wait': { title: '等待元素', icon: <IconGlobe /> },
    'browser-use:get_console_logs': { title: '查看控制台日志', icon: <IconGlobe /> },
    'browser-use:get_network_requests': { title: '查看网络请求', icon: <IconGlobe /> },
    'browser-use:get_cookies': { title: '读取 Cookie', icon: <IconGlobe /> },
    'browser-use:set_cookie': { title: '设置 Cookie', icon: <IconGlobe /> },
    'browser-use:clear_cookies': { title: '清除 Cookie', icon: <IconGlobe /> },
  }
  return map[`${skillId}:${action}`] ?? { title: '执行技能', icon: <IconWrench /> }
}

/** 工具名 → 中文显示名（用于审批弹窗等需要展示工具名的场景，不暴露英文原始名） */
export function toolDisplayName(name: string, args?: Record<string, unknown>): string {
  if (name === 'skill_run') {
    return skillActionMeta(String(args?.skillId ?? ''), String(args?.action ?? '')).title
  }
  return TOOL_META[name]?.title ?? '工具操作'
}

/** 风险等级 → 中文文案（用于审批弹窗，不暴露英文枚举值） */
export function riskLevelLabel(level: string): string {
  const map: Record<string, string> = {
    readonly: '只读',
    reversible: '可逆修改',
    irreversible: '不可逆操作',
    high: '高风险',
  }
  return map[level] ?? level
}

/** skill_run 的 params 提取一行摘要（browser-use → url/selector，computer-use → 动作） */
function skillRunSummary(args: Record<string, unknown>): string {
  const skillId = String(args.skillId ?? '')
  const action = String(args.action ?? '')
  const params = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {}
  if (skillId === 'browser-use') {
    if (action === 'navigate') return String(params.url ?? '')
    if (action === 'create') return params.url ? String(params.url) : params.appId ? String(params.appId) : ''
    if (action === 'click' || action === 'type' || action === 'wait') return String(params.selector ?? '')
    if (action === 'get_content') return params.selector ? String(params.selector) : ''
    if (action === 'scroll') return String(params.direction ?? '')
    if (action === 'close' || action === 'list') return params.appId ? String(params.appId) : ''
  }
  if (skillId === 'computer-use' && action === 'action') return String(params.action ?? '')
  return ''
}

/** 从工具参数提取一行摘要（读/写 → 路径，命令 → 命令，列目录 → 路径，电脑操作 → 动作） */
export function toolSummary(name: string, args?: Record<string, unknown>): string {
  if (!args) return ''
  const a = args
  if (name === 'skill_run') return skillRunSummary(args)
  if (name === 'read_file' || name === 'write_file') return String(a.path ?? '')
  if (name === 'run_command') return String(a.command ?? '')
  if (name === 'list_dir') return a.path ? String(a.path) : '当前目录'
  if (name === 'image_analyze') return String(a.imageUrl ?? '').slice(0, 48)
  if (name === 'computer_action') return String(a.action ?? '')
  if (name === 'computer_screenshot' || name === 'computer_ocr') return ''
  if (name === 'browser_navigate') return String(a.url ?? '')
  if (name === 'browser_create') return a.url ? String(a.url) : a.appId ? String(a.appId) : ''
  if (name === 'browser_click') return String(a.selector ?? '')
  if (name === 'browser_type') return String(a.selector ?? '')
  if (name === 'browser_get_content') return a.selector ? String(a.selector) : ''
  if (name === 'browser_wait') return String(a.selector ?? '')
  if (name === 'browser_scroll') return String(a.direction ?? '')
  if (name === 'browser_close' || name === 'browser_list') return a.appId ? String(a.appId) : ''
  return ''
}

/** 终端结果卡片：命令 + stdout/stderr（深色终端样式） */
function TerminalBlock({ command, stdout, stderr }: { command: string; stdout: string; stderr: string }) {
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {command && (
        <div style={{ padding: '8px 12px', background: '#282c34', color: '#61afef', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <span style={{ color: '#7f848e' }}>$ </span>
          {command}
        </div>
      )}
      {(stdout || stderr) && (
        <div style={{ padding: '8px 12px', background: '#1e1e1e', color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 280, overflowY: 'auto' }}>
          {stdout}
          {stderr && <span style={{ color: '#f48771' }}>{stderr}</span>}
        </div>
      )}
    </div>
  )
}

// ===== 行级 diff（git diff 风格，用于 write_file 结果展示）=====

type DiffLineType = 'context' | 'add' | 'del' | 'fold'

interface DiffLine {
  type: DiffLineType
  text: string
  oldLine?: number
  newLine?: number
}

/** 用 LCS 计算两段文本的行级差异（经过公共前后缀裁剪后中间段通常较小，DP 可接受） */
function lcsDiff(a: string[], b: string[], oldStart: number, newStart: number): DiffLine[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i]!, oldLine: oldStart + i, newLine: newStart + j })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]!, oldLine: oldStart + i })
      i++
    } else {
      out.push({ type: 'add', text: b[j]!, newLine: newStart + j })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i]!, oldLine: oldStart + i })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j]!, newLine: newStart + j })
    j++
  }
  return out
}

/** 计算完整 diff，并折叠大段未变上下文（变更行前后保留 3 行，中间折叠标记） */
function computeDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start++
  let endA = n
  let endB = m
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const lines: DiffLine[] = []
  for (let i = 0; i < start; i++) lines.push({ type: 'context', text: a[i]!, oldLine: i + 1, newLine: i + 1 })
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length > 4000 || midB.length > 4000) {
    for (const t of midA) lines.push({ type: 'del', text: t })
    for (const t of midB) lines.push({ type: 'add', text: t })
  } else {
    lines.push(...lcsDiff(midA, midB, start + 1, start + 1))
  }
  for (let i = 0; i < n - endA; i++) lines.push({ type: 'context', text: a[endA + i]!, oldLine: endA + i + 1, newLine: endB + i + 1 })

  const ctx = 3
  const keep = new Set<number>()
  lines.forEach((l, i) => {
    if (l.type === 'add' || l.type === 'del') {
      for (let d = -ctx; d <= ctx; d++) {
        const j = i + d
        if (j >= 0 && j < lines.length) keep.add(j)
      }
    }
  })
  const out: DiffLine[] = []
  let lastKept = -1
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (lastKept >= 0 && i - lastKept > 1) {
        out.push({ type: 'fold', text: `⋯ ${i - lastKept - 1} 行未变` })
      }
      out.push(lines[i]!)
      lastKept = i
    }
  }
  return out
}

/** 文件变更卡片：git diff 风格（- 红 / + 绿 / 上下文灰），新建与修改文件都适用 */
function DiffBlock({ before, after, path, isNew }: { before: string; after: string; path?: string; isNew?: boolean }) {
  const treatAsNew = isNew || before === ''
  const diffLines: DiffLine[] = treatAsNew
    ? after.split('\n').map((t, i): DiffLine => ({ type: 'add', text: t, newLine: i + 1 }))
    : computeDiff(before, after)
  const addCount = diffLines.filter((l) => l.type === 'add').length
  const delCount = diffLines.filter((l) => l.type === 'del').length
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {path && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {path} · {treatAsNew ? `新建文件，+${addCount}` : `+${addCount} −${delCount}`}
        </div>
      )}
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {diffLines.map((l, i) => {
          if (l.type === 'fold') {
            return (
              <div key={i} style={{ padding: '3px 12px', color: 'var(--text-muted)', fontSize: 11, background: 'var(--bg-sidebar)', textAlign: 'center', userSelect: 'none' }}>
                {l.text}
              </div>
            )
          }
          const bg = l.type === 'add' ? 'var(--tint-green)' : l.type === 'del' ? 'var(--tint-red)' : 'transparent'
          const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '
          const signColor = l.type === 'add' ? 'var(--success-text)' : l.type === 'del' ? 'var(--danger-text)' : 'var(--text-faint)'
          const textColor = l.type === 'del' ? 'var(--danger-text)' : l.type === 'add' ? 'var(--success-text)' : 'var(--text)'
          return (
            <div key={i} style={{ display: 'flex', background: bg, minHeight: 18 }}>
              <span style={{ width: 34, textAlign: 'right', paddingRight: 8, color: 'var(--text-faint)', flexShrink: 0, userSelect: 'none', background: 'rgba(0,0,0,0.02)' }}>{l.oldLine ?? ''}</span>
              <span style={{ width: 34, textAlign: 'right', paddingRight: 8, color: 'var(--text-faint)', flexShrink: 0, userSelect: 'none', background: 'rgba(0,0,0,0.02)' }}>{l.newLine ?? ''}</span>
              <span style={{ width: 20, textAlign: 'center', color: signColor, flexShrink: 0, userSelect: 'none', fontWeight: 600 }}>{sign}</span>
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1, color: textColor }}>{l.text || ' '}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 文件结果卡片：带行号的只读文件窗口（超长折叠） */
function FileBlock({ content, path }: { content: string; path?: string }) {
  const lines = content.split('\n')
  const MAX = 200
  const shown = lines.slice(0, MAX)
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {path && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {path} · {lines.length} 行
        </div>
      )}
      <div style={{ maxHeight: 320, overflowY: 'auto', padding: '4px 0' }}>
        {shown.map((line, i) => (
          <div key={i} style={{ display: 'flex', padding: '0 0' }}>
            <span style={{ width: 40, textAlign: 'right', paddingRight: 10, color: 'var(--text-faint)', flexShrink: 0, userSelect: 'none' }}>{i + 1}</span>
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1, color: 'var(--text)' }}>{line || ' '}</span>
          </div>
        ))}
        {lines.length > MAX && (
          <div style={{ color: 'var(--text-muted)', padding: '6px 12px', fontSize: 11 }}>… 共 {lines.length} 行，仅显示前 {MAX} 行</div>
        )}
      </div>
    </div>
  )
}

/** 从截图工具结果中提取可显示的图片 src：优先 https 链接（上传云存储），回退 base64 data URL */
function screenshotSrc(result: unknown): string {
  const r = result as { imageUrl?: string; imageBase64?: string }
  if (typeof r.imageUrl === 'string' && r.imageUrl) return r.imageUrl
  if (typeof r.imageBase64 === 'string' && r.imageBase64) return `data:image/png;base64,${r.imageBase64}`
  return ''
}

/** 按工具类型渲染结果卡片（read → 文件行号 / run_command → 终端 / list_dir → 树形 / 截图 → 图片 / 其他 → 纯文本脱敏） */
export function renderToolResult(name: string, result: unknown, error: string | undefined, args?: Record<string, unknown>): React.ReactNode | null {
  if (error) {
    return (
      <div style={{ padding: '10px 12px', color: 'var(--danger-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
        {redactSecret(error)}
      </div>
    )
  }
  if (result === undefined || result === null) return null
  if (name === 'run_command') {
    const r = result as { stdout?: string; stderr?: string }
    return <TerminalBlock command={String(args?.command ?? '')} stdout={r.stdout ?? ''} stderr={r.stderr ?? ''} />
  }
  if (name === 'list_dir') {
    return (
      <pre style={{ margin: 0, padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre', overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
        {String(result)}
      </pre>
    )
  }
  if (name === 'read_file') {
    return <FileBlock content={String(result)} path={String(args?.path ?? '')} />
  }
  if (name === 'skill_run' && args?.action === 'screenshot') {
    const src = screenshotSrc(result)
    return src ? <img src={src} alt="截图" style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : null
  }
  if (name === 'computer_screenshot') {
    const src = screenshotSrc(result)
    return src ? <img src={src} alt="截图" style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : null
  }
  if (name === 'browser_screenshot') {
    const src = screenshotSrc(result)
    return src ? <img src={src} alt="网页截图" style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : null
  }
  if (name === 'write_file') {
    const r = result as { ok?: boolean; path?: string; before?: string | null; after?: string; isNew?: boolean }
    if (typeof r.after === 'string') {
      return <DiffBlock before={r.before ?? ''} after={r.after} path={r.path} isNew={!!r.isNew} />
    }
    return <div style={{ padding: '10px 12px', color: 'var(--success-text)', fontSize: 12 }}>✓ 已写入 {r.path ?? ''}</div>
  }
  if (name === 'edit_file') {
    const r = result as { ok?: boolean; path?: string; before?: string | null; after?: string; occurrences?: number }
    if (typeof r.after === 'string') {
      return <DiffBlock before={r.before ?? ''} after={r.after} path={r.path} />
    }
    return <div style={{ padding: '10px 12px', color: 'var(--success-text)', fontSize: 12 }}>✓ 已编辑 {r.path ?? ''}</div>
  }
  return (
    <pre style={{ margin: 0, padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto' }}>
      {redactSecret(truncate(stringifyResult(result), 4000))}
    </pre>
  )
}

/** 工具执行步骤（DSH ToolRow 风格）：单行摘要（中文标题 + 摘要）+ 折叠的类型卡片 */
export function ToolStep({ trace }: { trace: ToolTrace }) {
  // 机制类工具（如 ask_user 提问）已有专用交互卡片，这里不再渲染工具步骤，避免暴露内部工具名
  if (HIDDEN_STEP_TOOLS.has(trace.name)) return null
  const [expanded, setExpanded] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const isCall = trace.kind === 'tool-call'
  const meta = trace.name === 'skill_run'
    ? skillActionMeta(String(trace.args?.skillId ?? ''), String(trace.args?.action ?? ''))
    : TOOL_META[trace.name] ?? { title: '工具操作', icon: <IconWrench /> }
  const state = isCall ? 'running' : trace.error ? 'error' : 'ok'
  const summary = toolSummary(trace.name, trace.args)
  const resultBody = !isCall ? renderToolResult(trace.name, trace.result, trace.error, trace.args) : null
  const expandable = resultBody !== null
  const stateColor = state === 'error' ? 'var(--danger-text)' : state === 'running' ? 'var(--accent)' : 'var(--success-text)'

  return (
    <div style={{ marginBottom: 3, fontSize: 13 }}>
      {/* 思考信息：显示在对应执行步骤的「上方」——先思考、再执行（若该步骤有思考），紧凑无边框 */}
      {trace.reasoning && (
        <div style={{ marginBottom: 3 }}>
          <button
            onClick={() => setReasoningOpen((v) => !v)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'transparent', color: 'var(--text-faint)', fontSize: 12, cursor: 'pointer', lineHeight: 1.5 }}
          >
            <span style={{ display: 'inline-flex', color: 'var(--text-faint)', transform: reasoningOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}>
              <IconChevronDown />
            </span>
            思考
          </button>
          {reasoningOpen && (
            <div style={{ marginTop: 2, paddingLeft: 10, borderLeft: '2px solid var(--border)', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>
              {trace.reasoning}
            </div>
          )}
        </div>
      )}
      <div
        onClick={() => expandable && setExpanded((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: expandable ? 'pointer' : 'default' }}
      >
        <span style={{ color: stateColor, display: 'inline-flex', flexShrink: 0 }}>{meta.icon}</span>
        <b style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13, flexShrink: 0 }}>{meta.title}</b>
        {summary && (
          <>
            <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>·</span>
            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{summary}</span>
          </>
        )}
        {state === 'running' && <span style={{ color: 'var(--accent)', fontSize: 12, flexShrink: 0 }}>执行中…</span>}
        {isCall && trace.approvalRequired && (
          <span style={{ fontSize: 11, padding: '0 6px', borderRadius: 4, background: 'var(--tint-orange)', color: 'var(--warning-text)', flexShrink: 0 }}>待确认</span>
        )}
        {expandable && (
          <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', display: 'inline-flex', flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
            <IconChevronDown />
          </span>
        )}
      </div>
      {expanded && expandable && (
        <div style={{ marginTop: 3, marginLeft: 18, borderLeft: '2px solid var(--border)', overflow: 'hidden' }}>
          {resultBody}
        </div>
      )}
    </div>
  )
}

/** 统计工具步骤执行情况（合并后的 ToolTrace 数组：每项为一次工具调用） */
export function toolStepStats(tools: ToolTrace[]): { total: number; success: number; failed: number; running: number } {
  let success = 0
  let failed = 0
  let running = 0
  for (const t of tools) {
    if (t.kind === 'tool-call') running++
    else if (t.error) failed++
    else success++
  }
  return { total: tools.length, success, failed, running }
}

/** 气泡顶部「步数统计」徽标：X 步 · Y 成功 · Z 失败 · W 执行中（按状态着色，无工具步骤时不渲染） */
export function StepStats({ tools }: { tools: ToolTrace[] }) {
  const { total, success, failed, running } = toolStepStats(tools)
  if (total === 0) return null
  return (
    <>
      <span> · </span>
      <span>{total} 步</span>
      {success > 0 && (
        <>
          <span> · </span>
          <span style={{ color: 'var(--success-text)' }}>{success} 成功</span>
        </>
      )}
      {failed > 0 && (
        <>
          <span> · </span>
          <span style={{ color: 'var(--danger-text)' }}>{failed} 失败</span>
        </>
      )}
      {running > 0 && (
        <>
          <span> · </span>
          <span style={{ color: 'var(--accent)' }}>{running} 执行中</span>
        </>
      )}
    </>
  )
}
