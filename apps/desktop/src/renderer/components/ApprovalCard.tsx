import * as React from 'react'
import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '../types'
import { DiffBlock, toolDisplayName, riskLevelLabel } from './ToolStep'
import { IconChevronDown, IconWarn } from './icons'
import { btn, formatArgs } from './ui'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

interface ApprovalCardProps {
  req: ApprovalRequest
  onAllow: () => void
  onReject: () => void
}

/** 审批弹窗参数展示：编辑/写入文件渲染 diff 前后对比，执行命令完整显示命令，其余回退友好键值对 */
function renderApprovalDetail(toolName: string, args: Record<string, unknown>): React.ReactNode {
  if (!args || Object.keys(args).length === 0) return <span style={{ color: 'var(--text-muted)' }}>{t('chat.approval.noArgs')}</span>
  if (toolName === 'edit_file') {
    const path = typeof args.path === 'string' ? args.path : ''
    const before = typeof args.oldText === 'string' ? args.oldText : ''
    const after = typeof args.newText === 'string' ? args.newText : ''
    return <DiffBlock before={before} after={after} path={path} />
  }
  if (toolName === 'write_file') {
    const path = typeof args.path === 'string' ? args.path : ''
    const content = typeof args.content === 'string' ? args.content : ''
    return <DiffBlock before="" after={content} path={path} isNew />
  }
  if (toolName === 'run_command') {
    const command = typeof args.command === 'string' ? args.command : ''
    return (
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
        {command && (
          <div style={{ padding: '8px 12px', background: '#282c34', color: '#61afef', whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderRadius: 8 }}>
            <span style={{ color: '#7f848e' }}>$ </span>
            {command}
          </div>
        )}
      </div>
    )
  }
  return formatArgs(args)
}

/**
 * 工具审批卡片（输入框上方浮动）。会话级隔离：只显示调用方传入的当前待审批请求。
 * 复用自 shell.chat 插件的既有审批弹窗（同一份实现，避免多处风格漂移）：
 * 允许一次 / 拒绝 两个动作由调用方传入，写盘前风险通过 riskLevel 标色。
 */
export function ApprovalCard({ req, onAllow, onReject }: ApprovalCardProps): React.JSX.Element {
  useLocaleSync()
  // 折叠状态（默认展开；新请求到来时自动展开）
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    setCollapsed(false)
  }, [req.id])

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 158,
        left: 16,
        right: 16,
        padding: 14,
        borderRadius: 12,
        border: '1px solid var(--tint-red-strong)',
        background: 'var(--tint-red)',
        fontSize: 13,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        // 任务114：卡片整体不得超出视口安全区。外层原本只有 bottom:158 下锚点、无高度上限，
        // 内容（长审批参数）一多就向上撑高，绘制到顶部标题栏之上，盖住最小化/最大化/关闭按钮。
        // 227 = 158（既有下锚点）+ 69（标题栏安全区）。用 maxHeight 不用 height：内容少时按内容高，不留白。
        maxHeight: 'calc(100% - 227px)',
        overflowY: 'auto',
        // 与原 AskCard 同层级，保证 portal 挂 body 后仍浮在窗口内容之上
        zIndex: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: collapsed ? 0 : 6 }}>
        <div style={{ fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconWarn />
          {t('chat.approval.title')}
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? t('common.expand') : t('common.collapse')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transform: collapsed ? 'none' : 'rotate(180deg)',
            transition: 'transform 0.15s ease',
          }}
        >
          <IconChevronDown />
        </button>
      </div>
      {!collapsed && (
        <>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>{t('chat.approval.toolLine', { tool: toolDisplayName(req.toolName, req.args), risk: riskLevelLabel(req.riskLevel) })}</div>
          {/* 任务114：审批详情（工具入参可达数 KB，如整文件写入）限高滚动，与 AskCard 同口径 */}
          <div style={{ color: 'var(--text-secondary)', marginBottom: 10, fontSize: 12, overflowWrap: 'break-word', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>
            {renderApprovalDetail(req.toolName, req.args)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onAllow} style={btn('var(--accent)', '#fff')}>
              {t('chat.approval.allowOnce')}
            </button>
            <button onClick={onReject} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>
              {t('chat.approval.reject')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
