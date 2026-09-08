import { memo, useMemo, useState } from 'react'
import type { ToolTrace } from '../types'
import { IconActivity, IconAvatar, IconChevronDown, IconClock, IconCode, IconEdit, IconFile, IconGlobe, IconImage, IconMonitor, IconPlus, IconRefresh, IconSend, IconShield, IconTerminal, IconTrash, IconTree, IconUsers, IconWrench } from './icons'
import { formatDuration, redactSecret, stringifyResult, truncate } from './ui'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

// ===== 工具调用渲染（单行摘要 + 类型卡片，不显示 JSON）=====

/** 已有专门交互 UI 的机制类工具：不在聊天流里以「工具步骤」卡片形式显示（避免暴露内部工具名 + 与专用卡片重复展示） */
const HIDDEN_STEP_TOOLS = new Set(['ask_user'])

/**
 * 工具名 → 图标 + **词条键**（原始工具名对普通人不可读）。
 *
 * 【为什么表里存 k 而不是 title】表在模块顶层，若把中文标题写进表里，标题就在**模块加载时**被固化成
 * 中文，切换语言不会变（期 1 的 STATUS_LABEL 就是这个坑）。所以表只存 key，标题一律在渲染时 t() 取。
 */
export const TOOL_META: Record<string, { k: string; icon: React.ReactNode }> = {
  read_file: { k: 'chat.tool.read_file', icon: <IconFile /> },
  write_file: { k: 'chat.tool.write_file', icon: <IconEdit /> },
  edit_file: { k: 'chat.tool.edit_file', icon: <IconEdit /> },
  run_command: { k: 'chat.tool.run_command', icon: <IconTerminal /> },
  list_dir: { k: 'chat.tool.list_dir', icon: <IconTree /> },
  image_analyze: { k: 'chat.tool.image_analyze', icon: <IconImage /> },
  computer_screenshot: { k: 'chat.tool.computer_screenshot', icon: <IconMonitor /> },
  computer_ocr: { k: 'chat.tool.computer_ocr', icon: <IconMonitor /> },
  computer_action: { k: 'chat.tool.computer_action', icon: <IconMonitor /> },
  browser_create: { k: 'chat.tool.browser_create', icon: <IconGlobe /> },
  browser_list: { k: 'chat.tool.browser_list', icon: <IconGlobe /> },
  browser_navigate: { k: 'chat.tool.browser_navigate', icon: <IconGlobe /> },
  browser_close: { k: 'chat.tool.browser_close', icon: <IconGlobe /> },
  browser_screenshot: { k: 'chat.tool.browser_screenshot', icon: <IconGlobe /> },
  browser_get_info: { k: 'chat.tool.browser_get_info', icon: <IconGlobe /> },
  browser_get_content: { k: 'chat.tool.browser_get_content', icon: <IconGlobe /> },
  browser_evaluate: { k: 'chat.tool.browser_evaluate', icon: <IconGlobe /> },
  browser_click: { k: 'chat.tool.browser_click', icon: <IconGlobe /> },
  browser_type: { k: 'chat.tool.browser_type', icon: <IconGlobe /> },
  browser_scroll: { k: 'chat.tool.browser_scroll', icon: <IconGlobe /> },
  browser_wait: { k: 'chat.tool.browser_wait', icon: <IconGlobe /> },
  browser_get_console_logs: { k: 'chat.tool.browser_get_console_logs', icon: <IconGlobe /> },
  browser_get_network_requests: { k: 'chat.tool.browser_get_network_requests', icon: <IconGlobe /> },
  browser_get_cookies: { k: 'chat.tool.browser_get_cookies', icon: <IconGlobe /> },
  browser_set_cookie: { k: 'chat.tool.browser_set_cookie', icon: <IconGlobe /> },
  browser_clear_cookies: { k: 'chat.tool.browser_clear_cookies', icon: <IconGlobe /> },
  rollback_file: { k: 'chat.tool.rollback_file', icon: <IconEdit /> },
  remember: { k: 'chat.tool.remember', icon: <IconClock /> },
  recall_memory: { k: 'chat.tool.recall_memory', icon: <IconClock /> },
  plugin: { k: 'chat.tool.plugin', icon: <IconCode /> },
  // 会话管家（主 Agent）专属工具：用于审批弹窗展示可读名称，避免暴露英文原始名
  session: { k: 'chat.tool.session', icon: <IconUsers /> },
  list_models: { k: 'chat.tool.list_models', icon: <IconActivity /> },
  send_message: { k: 'chat.tool.send_message', icon: <IconSend /> },
  inject_message: { k: 'chat.tool.inject_message', icon: <IconSend /> },
  mcp_list_tools: { k: 'chat.tool.mcp_list_tools', icon: <IconWrench /> },
  mcp_call: { k: 'chat.tool.mcp_call', icon: <IconWrench /> },
  skill_list: { k: 'chat.tool.skill_list', icon: <IconWrench /> },
  skill_read: { k: 'chat.tool.skill_read', icon: <IconWrench /> },
  terminal_create: { k: 'chat.tool.terminal_create', icon: <IconTerminal /> },
  terminal_run: { k: 'chat.tool.terminal_run', icon: <IconTerminal /> },
  terminal_list: { k: 'chat.tool.terminal_list', icon: <IconTerminal /> },
  terminal_close: { k: 'chat.tool.terminal_close', icon: <IconTerminal /> },
  ledger: { k: 'chat.tool.ledger', icon: <IconFile /> },
  answer_ask: { k: 'chat.tool.answer_ask', icon: <IconSend /> },
  resolve_approval: { k: 'chat.tool.resolve_approval', icon: <IconShield /> },
}

/** skill_run（可执行技能统一入口）的 skillId + action → 中文标题 + 图标 */
function skillActionMeta(skillId: string, action: string): { k: string; icon: React.ReactNode } {
  const map: Record<string, { k: string; icon: React.ReactNode }> = {
    'computer-use:screenshot': { k: 'chat.tool.computer_screenshot', icon: <IconMonitor /> },
    'computer-use:ocr': { k: 'chat.tool.computer_ocr', icon: <IconMonitor /> },
    'computer-use:read_tree': { k: 'chat.tool.computer_read_tree', icon: <IconMonitor /> },
    'computer-use:action': { k: 'chat.tool.computer_action', icon: <IconMonitor /> },
    'browser-use:create': { k: 'chat.tool.browser_create', icon: <IconGlobe /> },
    'browser-use:list': { k: 'chat.tool.browser_list', icon: <IconGlobe /> },
    'browser-use:navigate': { k: 'chat.tool.browser_navigate', icon: <IconGlobe /> },
    'browser-use:close': { k: 'chat.tool.browser_close', icon: <IconGlobe /> },
    'browser-use:screenshot': { k: 'chat.tool.browser_screenshot', icon: <IconGlobe /> },
    'browser-use:get_info': { k: 'chat.tool.browser_get_info', icon: <IconGlobe /> },
    'browser-use:get_content': { k: 'chat.tool.browser_get_content', icon: <IconGlobe /> },
    'browser-use:evaluate': { k: 'chat.tool.browser_evaluate', icon: <IconGlobe /> },
    'browser-use:click': { k: 'chat.tool.browser_click', icon: <IconGlobe /> },
    'browser-use:type': { k: 'chat.tool.browser_type', icon: <IconGlobe /> },
    'browser-use:scroll': { k: 'chat.tool.browser_scroll', icon: <IconGlobe /> },
    'browser-use:wait': { k: 'chat.tool.browser_wait', icon: <IconGlobe /> },
    'browser-use:get_console_logs': { k: 'chat.tool.browser_get_console_logs', icon: <IconGlobe /> },
    'browser-use:get_network_requests': { k: 'chat.tool.browser_get_network_requests', icon: <IconGlobe /> },
    'browser-use:get_cookies': { k: 'chat.tool.browser_get_cookies', icon: <IconGlobe /> },
    'browser-use:set_cookie': { k: 'chat.tool.browser_set_cookie', icon: <IconGlobe /> },
    'browser-use:clear_cookies': { k: 'chat.tool.browser_clear_cookies', icon: <IconGlobe /> },
  }
  return map[`${skillId}:${action}`] ?? { k: 'chat.tool.skillFallback', icon: <IconWrench /> }
}

/** plugin 顶层工具（插件统一入口）的 action → 中文标题 + 图标 */
function pluginActionMeta(action: string): { k: string; icon: React.ReactNode } {
  const map: Record<string, { k: string; icon: React.ReactNode }> = {
    list: { k: 'chat.tool.pluginAction.list', icon: <IconCode /> },
    inspect: { k: 'chat.tool.pluginAction.inspect', icon: <IconCode /> },
    scaffold: { k: 'chat.tool.pluginAction.scaffold', icon: <IconCode /> },
    build: { k: 'chat.tool.pluginAction.build', icon: <IconCode /> },
    'test-load': { k: 'chat.tool.pluginAction.test-load', icon: <IconCode /> },
    verify: { k: 'chat.tool.pluginAction.verify', icon: <IconCode /> },
    install: { k: 'chat.tool.pluginAction.install', icon: <IconCode /> },
    publish: { k: 'chat.tool.pluginAction.publish', icon: <IconCode /> },
    uninstall: { k: 'chat.tool.pluginAction.uninstall', icon: <IconCode /> },
    tool: { k: 'chat.tool.pluginAction.tool', icon: <IconWrench /> },
  }
  return map[action] ?? { k: 'chat.tool.plugin', icon: <IconCode /> }
}

/** ledger 顶层工具（管家台账统一入口）的 action → 中文标题 + 图标 */
function ledgerActionMeta(action: string): { k: string; icon: React.ReactNode } {
  const map: Record<string, { k: string; icon: React.ReactNode }> = {
    list: { k: 'chat.tool.ledgerAction.list', icon: <IconFile /> },
    read: { k: 'chat.tool.ledgerAction.read', icon: <IconFile /> },
    write: { k: 'chat.tool.ledgerAction.write', icon: <IconFile /> },
    edit: { k: 'chat.tool.ledgerAction.edit', icon: <IconFile /> },
  }
  return map[action] ?? { k: 'chat.tool.ledger', icon: <IconFile /> }
}

/** session 顶层工具（会话实体管理统一入口）的 action → 中文标题 + 图标 */
function sessionActionMeta(action: string): { k: string; icon: React.ReactNode } {
  const map: Record<string, { k: string; icon: React.ReactNode }> = {
    list: { k: 'chat.tool.sessionAction.list', icon: <IconUsers /> },
    inspect: { k: 'chat.tool.sessionAction.inspect', icon: <IconUsers /> },
    switch: { k: 'chat.tool.sessionAction.switch', icon: <IconRefresh /> },
    create: { k: 'chat.tool.sessionAction.create', icon: <IconPlus /> },
    rename: { k: 'chat.tool.sessionAction.rename', icon: <IconEdit /> },
    set_workdir: { k: 'chat.tool.sessionAction.set_workdir', icon: <IconEdit /> },
    delete: { k: 'chat.tool.sessionAction.delete', icon: <IconTrash /> },
    set_model: { k: 'chat.tool.sessionAction.set_model', icon: <IconActivity /> },
    set_approval: { k: 'chat.tool.sessionAction.set_approval', icon: <IconShield /> },
    choose: { k: 'chat.tool.sessionAction.choose', icon: <IconUsers /> },
    resume: { k: 'chat.tool.sessionAction.resume', icon: <IconRefresh /> },
  }
  return map[action] ?? { k: 'chat.tool.session', icon: <IconUsers /> }
}

/**
 * 工具名 → **当前语言**的显示名（渲染时取词，切换语言立即跟着变）。
 * 找不到登记时退回原始工具名（TracePanel 依赖这个行为：调试面板要看真名），全空才用兜底词。
 */
export function toolTitle(name: string): string {
  const k = TOOL_META[name]?.k
  return k ? t(k) : (name || t('chat.tool.fallback'))
}

/** 工具名 → 显示名（用于审批弹窗等需要展示工具名的场景，不暴露英文原始名） */
export function toolDisplayName(name: string, args?: Record<string, unknown>): string {
  if (name === 'skill_run') {
    return t(skillActionMeta(String(args?.skillId ?? ''), String(args?.action ?? '')).k)
  }
  if (name === 'plugin') {
    return t(pluginActionMeta(String(args?.action ?? '')).k)
  }
  if (name === 'ledger') {
    return t(ledgerActionMeta(String(args?.action ?? '')).k)
  }
  if (name === 'session') {
    return t(sessionActionMeta(String(args?.action ?? '')).k)
  }
  return toolTitle(name)
}

/** 风险等级 → 当前语言文案（用于审批弹窗，不暴露英文枚举值；未登记的等级原样显示） */
export function riskLevelLabel(level: string): string {
  const map: Record<string, string> = {
    readonly: 'chat.risk.readonly',
    reversible: 'chat.risk.reversible',
    irreversible: 'chat.risk.irreversible',
    high: 'chat.risk.high',
  }
  const k = map[level]
  return k ? t(k) : level
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
  if (name === 'plugin') {
    const action = String(a.action ?? '')
    const inner = a.args && typeof a.args === 'object' ? (a.args as Record<string, unknown>) : {}
    if (action === 'install' || action === 'uninstall' || action === 'scaffold' || action === 'build' || action === 'test-load' || action === 'verify') return String(inner.id ?? '')
    if (action === 'publish') return String(inner.pluginDir ?? inner.id ?? '')
    if (action === 'tool') return `${String(a.pluginId ?? '')}/${String(a.tool ?? '')}`
    if (action === 'list') return ''
    return ''
  }
  if (name === 'ledger') return String(a.path ?? '')
  if (name === 'session') return String(a.sessionId ?? '')
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'rollback_file') return String(a.path ?? '')
  if (name === 'run_command') return String(a.command ?? '')
  if (name === 'list_dir') return a.path ? String(a.path) : t('chat.tool.currentDir')
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
  /** 行原文；fold 类型不用它（文案必须在渲染时取词，见 foldCount） */
  text: string
  /** 折叠行「未变多少行」的数量：只存数字，语言在渲染时决定 */
  foldCount?: number
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
        out.push({ type: 'fold', text: '', foldCount: i - lastKept - 1 })
      }
      out.push(lines[i]!)
      lastKept = i
    }
  }
  return out
}

/** 文件变更卡片：git diff 风格（- 红 / + 绿 / 上下文灰），新建与修改文件都适用 */
export const DiffBlock = memo(function DiffBlock({ before, after, path, isNew }: { before: string; after: string; path?: string; isNew?: boolean }) {
  useLocaleSync()
  const treatAsNew = isNew || before === ''
  // 卡顿优化：diff 计算（含 O(n·m) 的 lcsDiff）用 useMemo 缓存，仅在 before/after/是否新建变化时重算，
  // 避免编辑/写入文件工具结果在历史消息被反复重渲染时重复做昂贵的行级 diff。
  const diffLines: DiffLine[] = useMemo(
    () => (treatAsNew
      ? after.split('\n').map((t, i): DiffLine => ({ type: 'add', text: t, newLine: i + 1 }))
      : computeDiff(before, after)),
    [before, after, treatAsNew],
  )
  const addCount = diffLines.filter((l) => l.type === 'add').length
  const delCount = diffLines.filter((l) => l.type === 'del').length
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {path && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {path} · {treatAsNew ? t('chat.diff.newFile', { n: addCount }) : t('chat.diff.stat', { add: addCount, del: delCount })}
        </div>
      )}
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {diffLines.map((l, i) => {
          if (l.type === 'fold') {
            return (
              <div key={i} style={{ padding: '3px 12px', color: 'var(--text-muted)', fontSize: 11, background: 'var(--bg-sidebar)', textAlign: 'center', userSelect: 'none' }}>
                {t('chat.diff.unchanged', { n: l.foldCount ?? 0 })}
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
})

/** 文件结果卡片：带行号的只读文件窗口（超长折叠） */
function FileBlock({ content, path }: { content: string; path?: string }) {
  useLocaleSync()
  const lines = content.split('\n')
  const MAX = 200
  const shown = lines.slice(0, MAX)
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {path && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {path} · {t('chat.file.lineCount', { n: lines.length })}
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
          <div style={{ color: 'var(--text-muted)', padding: '6px 12px', fontSize: 11 }}>{[t('chat.file.truncatedTotal', { n: lines.length }), t('chat.file.truncatedShown', { n: MAX })].join(t('common.sepComma'))}</div>
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
    return src ? <img src={src} alt={t('chat.tool.screenshotAlt')} style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : null
  }
  if (name === 'computer_screenshot') {
    const src = screenshotSrc(result)
    return src ? <img src={src} alt={t('chat.tool.screenshotAlt')} style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : null
  }
  if (name === 'browser_screenshot') {
    const src = screenshotSrc(result)
    return src ? <img src={src} alt={t('chat.tool.pageScreenshotAlt')} style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /> : null
  }
  if (name === 'write_file') {
    const r = result as { ok?: boolean; path?: string; before?: string | null; after?: string; isNew?: boolean }
    if (typeof r.after === 'string') {
      return <DiffBlock before={r.before ?? ''} after={r.after} path={r.path} isNew={!!r.isNew} />
    }
    return <div style={{ padding: '10px 12px', color: 'var(--success-text)', fontSize: 12 }}>{t('chat.tool.written', { path: r.path ?? '' })}</div>
  }
  if (name === 'edit_file') {
    const r = result as { ok?: boolean; path?: string; before?: string | null; after?: string; occurrences?: number }
    if (typeof r.after === 'string') {
      return <DiffBlock before={r.before ?? ''} after={r.after} path={r.path} />
    }
    return <div style={{ padding: '10px 12px', color: 'var(--success-text)', fontSize: 12 }}>{t('chat.tool.edited', { path: r.path ?? '' })}</div>
  }
  return (
    <pre style={{ margin: 0, padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto' }}>
      {redactSecret(truncate(stringifyResult(result), 4000))}
    </pre>
  )
}

/** 工具执行步骤：单行摘要（中文标题 + 摘要）+ 折叠的类型卡片 */
export const ToolStep = memo(function ToolStep({ trace, expanded, onToggle }: { trace: ToolTrace; expanded?: boolean; onToggle?: () => void }) {
  // 机制类工具（如 ask_user 提问）已有专用交互卡片，这里不再渲染工具步骤，避免暴露内部工具名
  if (HIDDEN_STEP_TOOLS.has(trace.name)) return null
  const [innerExpanded, setInnerExpanded] = useState(false)
  // 受控展开（外层 ToolGroup 传入）优先；未传时退回内部 state（兼容既有三处直接 <ToolStep/> 的调用）
  const isExpanded = expanded !== undefined ? expanded : innerExpanded
  const toggleExpanded = () => {
    if (onToggle) onToggle()
    else setInnerExpanded((v) => !v)
  }
  const [reasoningOpen, setReasoningOpen] = useState(false)
  useLocaleSync()
  const isCall = trace.kind === 'tool-call'
  const meta = trace.name === 'skill_run'
    ? skillActionMeta(String(trace.args?.skillId ?? ''), String(trace.args?.action ?? ''))
    : trace.name === 'plugin'
      ? pluginActionMeta(String(trace.args?.action ?? ''))
      : trace.name === 'ledger'
        ? ledgerActionMeta(String(trace.args?.action ?? ''))
        : trace.name === 'session'
          ? sessionActionMeta(String(trace.args?.action ?? ''))
          : TOOL_META[trace.name] ?? { k: 'chat.tool.fallback', icon: <IconWrench /> }
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
            {t('chat.tool.thinking')}
          </button>
          {reasoningOpen && (
            <div style={{ marginTop: 2, paddingLeft: 10, borderLeft: '2px solid var(--border)', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>
              {trace.reasoning}
            </div>
          )}
        </div>
      )}
      <div
        onClick={() => expandable && toggleExpanded()}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: expandable ? 'pointer' : 'default' }}
      >
        <span style={{ color: stateColor, display: 'inline-flex', flexShrink: 0 }}>{meta.icon}</span>
        <b style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13, flexShrink: 0 }}>{t(meta.k)}</b>
        {summary && (
          <>
            <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>·</span>
            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{summary}</span>
          </>
        )}
        {state === 'running' && <span style={{ color: 'var(--accent)', fontSize: 12, flexShrink: 0 }}>{t('chat.tool.running')}</span>}
        {isCall && trace.approvalRequired && (
          <span style={{ fontSize: 11, padding: '0 6px', borderRadius: 4, background: 'var(--tint-orange)', color: 'var(--warning-text)', flexShrink: 0 }}>{t('chat.tool.pendingApproval')}</span>
        )}
        {expandable && (
          <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', display: 'inline-flex', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
            <IconChevronDown />
          </span>
        )}
      </div>
      {isExpanded && expandable && (
        <div style={{ marginTop: 3, marginLeft: 18, borderLeft: '2px solid var(--border)', overflow: 'hidden' }}>
          {resultBody}
        </div>
      )}
    </div>
  )
})

/** 工具调用开合状态的 localStorage 持久化键（与 theme / 草稿缓存同机制，跨切换会话 / 重进窗口保留） */
const TOOL_GROUP_STATE_KEY = 'shanhai-tool-group-state'

interface ToolGroupState {
  /** 外层「整段工具调用」折叠状态：groupKey → collapsed */
  groups: Record<string, boolean>
  /** 内层各工具步骤展开状态：stepKey → expanded（只存 true，默认折叠不占存储） */
  steps: Record<string, boolean>
}

/** 读开合状态（容错：JSON 坏 / localStorage 不可用都回退空表，不崩溃） */
function readToolGroupState(): ToolGroupState {
  try {
    if (typeof window === 'undefined') return { groups: {}, steps: {} }
    const raw = window.localStorage.getItem(TOOL_GROUP_STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        return {
          groups: (parsed.groups && typeof parsed.groups === 'object') ? parsed.groups as Record<string, boolean> : {},
          steps: (parsed.steps && typeof parsed.steps === 'object') ? parsed.steps as Record<string, boolean> : {},
        }
      }
    }
  } catch {
    /* 忽略：localStorage 不可用（隐私模式）时静默回退 */
  }
  return { groups: {}, steps: {} }
}

/** 写开合状态（try/catch 容错，与 theme.ts 同口径） */
function writeToolGroupState(state: ToolGroupState): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(TOOL_GROUP_STATE_KEY, JSON.stringify(state))
  } catch {
    /* 忽略 */
  }
}

/** 一段工具调用的分组键：sessionId + 首个 callId，唯一标识同一轮次（callId 为 `${name}-${ts}-${random}` 全局唯一） */
function toolGroupKey(tools: ToolTrace[]): string {
  const first = tools[0]
  return first ? `${first.sessionId}:${first.callId}` : ''
}

/** 单个工具步骤的持久化键 */
function toolStepKey(t: ToolTrace): string {
  return `${t.sessionId}:${t.callId}`
}

/**
 * 外层「整段工具调用」折叠容器：摘要行（N 步 · 总耗时 · 异常徽标）+ 展开后内层各条 ToolStep（受控展开）。
 * - 外层折叠时**不挂载**内部内容（条件渲染），长会话上百条工具调用不常驻 DOM。
 * - 内层各步骤开合状态提升到本组件持有并持久化，外层折叠卸载内层后重开仍恢复原开合态。
 * - 异常（失败 / 高危待审批）在外层折叠行上以徽标透出，即使收起也可见。
 */
export const ToolGroup = memo(function ToolGroup({ tools, live }: { tools: ToolTrace[]; live?: boolean }) {
  useLocaleSync()
  const groupKey = useMemo(() => toolGroupKey(tools), [tools])
  const stepKeys = useMemo(() => tools.map(toolStepKey), [tools])

  // 统计：失败数 / 高危（待审批）数 / 已完成工具耗时（durationMs 求和；拿不到就不显示）
  const stats = useMemo(() => {
    let failed = 0
    let highRisk = 0
    let doneMs = 0
    for (const t of tools) {
      if (t.kind === 'tool-result') {
        if (t.error) failed++
        doneMs += t.durationMs ?? 0
      }
      if (t.approvalRequired) highRisk++
    }
    return { failed, highRisk, doneMs }
  }, [tools])

  // 外层折叠：执行中（live）强制展开让用户看到 AI 在干活；历史消息默认收起为摘要行；
  // 用户手动开合写入 localStorage 后以用户选择为准（不再自动改）。
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const state = readToolGroupState()
    if (groupKey && typeof state.groups[groupKey] === 'boolean') return state.groups[groupKey]!
    if (live) return false
    return true
  })

  // 内层各步骤展开状态：提升到本组件持有（外层折叠卸载内层时不丢失），持久化
  const [innerExpanded, setInnerExpanded] = useState<Record<string, boolean>>(() => {
    const state = readToolGroupState()
    const map: Record<string, boolean> = {}
    for (const k of stepKeys) {
      if (state.steps[k] === true) map[k] = true
    }
    return map
  })

  const toggleGroup = () => {
    const next = !collapsed
    setCollapsed(next)
    if (groupKey) {
      const state = readToolGroupState()
      state.groups[groupKey] = next
      writeToolGroupState(state)
    }
  }

  const toggleInner = (stepKey: string) => {
    setInnerExpanded((prev) => {
      const next = { ...prev, [stepKey]: !prev[stepKey] }
      const state = readToolGroupState()
      if (next[stepKey]) state.steps[stepKey] = true
      else delete state.steps[stepKey]
      writeToolGroupState(state)
      return next
    })
  }

  if (tools.length === 0) return null

  return (
    <div style={{ marginBottom: 4, fontSize: 13 }}>
      {/* 外层摘要行：chevron + N 步 + 总耗时 + 异常徽标（折叠态下徽标也可见） */}
      <div
        onClick={toggleGroup}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--text-faint)', flexShrink: 0, transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .15s' }}>
          <IconChevronDown />
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12, flexShrink: 0 }}>{t('chat.toolGroup.summary', { n: tools.length })}</span>
        {stats.doneMs > 0 && (
          <>
            <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>·</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12, flexShrink: 0 }}>{formatDuration(stats.doneMs)}</span>
          </>
        )}
        {live && <span style={{ color: 'var(--accent)', fontSize: 12, flexShrink: 0 }}>{t('chat.tool.running')}</span>}
        {stats.failed > 0 && (
          <span style={{ fontSize: 11, padding: '0 6px', borderRadius: 4, background: 'var(--tint-red)', color: 'var(--danger-text)', flexShrink: 0 }}>{t('chat.toolGroup.failedBadge', { n: stats.failed })}</span>
        )}
        {stats.highRisk > 0 && (
          <span style={{ fontSize: 11, padding: '0 6px', borderRadius: 4, background: 'var(--tint-orange)', color: 'var(--warning-text)', flexShrink: 0 }}>{t('chat.toolGroup.highRiskBadge', { n: stats.highRisk })}</span>
        )}
      </div>
      {/* 展开才挂载内层（条件渲染），折叠不占 DOM */}
      {!collapsed && (
        <div style={{ marginTop: 2, marginLeft: 10, borderLeft: '2px solid var(--border)', paddingLeft: 6 }}>
          {tools.map((t) => {
            const key = toolStepKey(t)
            return (
              <ToolStep
                key={t.callId}
                trace={t}
                expanded={innerExpanded[key] === true}
                onToggle={() => toggleInner(key)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
})

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
  useLocaleSync()
  const { total, success, failed, running } = toolStepStats(tools)
  if (total === 0) return null
  return (
    <>
      <span> · </span>
      <span>{t('chat.step.total', { n: total })}</span>
      {success > 0 && (
        <>
          <span> · </span>
          <span style={{ color: 'var(--success-text)' }}>{t('chat.step.success', { n: success })}</span>
        </>
      )}
      {failed > 0 && (
        <>
          <span> · </span>
          <span style={{ color: 'var(--danger-text)' }}>{t('chat.step.failed', { n: failed })}</span>
        </>
      )}
      {running > 0 && (
        <>
          <span> · </span>
          <span style={{ color: 'var(--accent)' }}>{t('chat.step.running', { n: running })}</span>
        </>
      )}
    </>
  )
}
