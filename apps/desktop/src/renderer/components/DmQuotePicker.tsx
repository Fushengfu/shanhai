import * as React from 'react'
import { useRef } from 'react'
import { IconClose, IconMonitor, IconWarn } from './icons'
import { btn, smallIconBtn } from './ui'
import { useDismissOnClickOutside } from './useDismissOnClickOutside'
import { fmtListTime } from './DmIm'
// 【i18n 期1】取词函数导入成 tKey：本文件的 targets.map((t) => …) 回调形参就叫 t（会话条目），
// 直接 import { t } 会在回调里被遮蔽 —— 与其改回调形参（动到既有代码），不如给取词函数起个不冲突的名字。
import { t as tKey } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

/**
 * 【任务 63】私信「引用到会话」的**目标会话选择器**。
 *
 * 为什么要它：改前是一条常驻的 `<select>`（把选择成本前置且不明显 —— 用户得先在下拉里选对目标，
 * 再点消息旁的 ＋），用户明确要求改成「点引用按钮时弹出引用到哪个会话」。
 *
 * 三条硬口径：
 *  1. **只列既有能力支持的目标**：`listSessions()` 的全部普通会话 + 会话管家。
 *     不新增任何 IPC / 主进程 handler —— 主进程 quoteDmToSession 也只投 chat / supervisor 两类窗口。
 *  2. **不回显会员ID**（任务 58 的延续）：来源名与预览都由调用方归一后才传进来
 *     （fromLabel 走 displayNameOf，preview 走 dmContentPreview），本组件自己不做任何 id 兜底；
 *     会话标题为空时显示「未命名会话」，也**不**回落成会话 id 串。
 *  3. **失败不静默**：目标窗口没开、会话已被删、未登录、凭证失效、通道异常等，全部由调用方
 *     通过 `errorText` 传进来，显示在选择器**内部**（关掉弹层就等于把失败原因一起丢掉）。
 *
 * 弹层收起口径照抄项目既有范式（useDismissOnClickOutside：本窗口内 mousedown capture + Esc；
 * 不加 window blur、不加桌面壳广播 —— 任务 48 用户明确不要）。
 */

export interface DmQuoteTarget {
  id: string
  /** 会话标题（空串时本组件显示「未命名会话」，不显示 id） */
  title: string
  lastActiveAt?: number
  busy?: boolean
  /** 是否就是用户当前正在看的会话：标「当前」并置顶 */
  current?: boolean
}

export interface DmQuotePickerProps {
  /** 被引用私信的**来源显示名**（调用方必须已走 displayNameOf，禁止传会员ID） */
  fromLabel: string
  /** 被引用私信的**一行预览**（调用方必须已走 dmContentPreview，禁止传裸 JSON） */
  preview: string
  targets: DmQuoteTarget[]
  /** 失败原因：在选择器内可见呈现；非空时弹层保持打开，不静默关闭 */
  errorText?: string | null
  /** 中性提示（如「已追加过，未重复塞两遍」）：不是故障，所以用中性色而不是红色 */
  hintText?: string | null
  /** 正在发出引用（防连点：期间所有条目禁用） */
  pending?: boolean
  onPick: (t: DmQuoteTarget) => void
  onClose: () => void
}

/** 弹层宽度：窄窗口（<640）下靠 90vw 收住，不溢出 */
const PANEL_STYLE: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(430px, 90vw)',
  maxHeight: '72vh',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 12,
  border: '1px solid var(--border-strong)',
  background: 'var(--bg-panel)',
  color: 'var(--text)',
  boxShadow: '0 10px 34px rgba(0,0,0,0.28)',
  zIndex: 900,
  overflow: 'hidden',
}

export function DmQuotePicker(props: DmQuotePickerProps): React.JSX.Element {
  // 自订阅语言变化（理由同 MemberPanel）
  useLocaleSync()
  const boxRef = useRef<HTMLDivElement>(null)
  useDismissOnClickOutside({ open: true, containerRef: boxRef, onDismiss: props.onClose })
  // 当前会话置顶，其余按最近活跃倒序（listSessions 本身已按 lastActiveAt 排，这里只把「当前」提到最前）
  const targets = [...props.targets].sort((a, b) => (b.current === true ? 1 : 0) - (a.current === true ? 1 : 0))
  return (
    <div ref={boxRef} style={PANEL_STYLE} role="dialog" aria-label={tKey('dm.quote.ariaLabel')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
        <span style={{ display: 'inline-flex', color: 'var(--text-secondary)', flexShrink: 0 }}><IconMonitor /></span>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>{tKey('dm.quote.pickerTitle')}</span>
        <button onClick={props.onClose} title={tKey('dm.quote.pickerCancelTip')} style={{ ...smallIconBtn, width: 22, height: 22, flexShrink: 0 }}>
          <IconClose />
        </button>
      </div>

      {/* 被引用的内容：来源名与预览都由调用方归一，这里绝不出现会员ID，也不出现附件 JSON 串码 */}
      {/*
        【任务112】顶部「被引用消息」区限高 + 内部滚动（修「长私信把底部会话列表挤出可视区」）。
        成因（读码实证，非猜）：
         - preview 走 dmContentPreview，而它**对纯文本消息原样返回全文、不截断**
           （shared/dm-attachment.ts 的 dmContentPreview：`if (atts.length === 0) return raw ?? ''`），
           一条私信上限 = DM_MAX_CONTENT_BYTES 字节（任务113 时 4000≈1300 汉字；任务115 放宽到 40000≈1.3 万汉字）
           → 这块能撑到几千乃至几万 px 高，所以限高滚动是必须的；
         - 本块改前是 `flexShrink: 0` 且**没有 maxHeight / overflow** —— 既不封顶也不肯收缩；
         - 弹层是 flex column + `maxHeight: 72vh` + `overflow: 'hidden'`（:64/:73），
           底部会话列表是 `flex: 1, minHeight: 0`（:116）：flex-basis 为 0，只能靠**剩余空间**长高；
           顶部这块把 72vh 吃干后没有剩余空间 → 列表高度归 0，再被 overflow:hidden 整块裁掉
           → 用户看到「消息一多，底部会话列表被挤出显示区域」。
        修法：限高用 maxHeight（**不写死 height**，内容少时不占多余空间，避开任务107 那类留白坑）
        + overflowY 内部滚动，滚动样式照抄项目既有实现（ReasoningBlock.tsx:22 / SessionPicker.tsx:55
        同为 `maxHeight: <px>, overflowY: 'auto'`，不另立滚动条外观）；同时把 flexShrink 放开为 1 + minHeight:0，
        使极矮窗口下**由消息区继续让位**，而不是把底部列表/页脚裁掉（优先级：会话列表 > 引用预览）。
      */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-soft)', fontSize: 12, lineHeight: 1.6, background: 'var(--bg-subtle)', flexShrink: 1, minHeight: 0, maxHeight: 'min(200px, 28vh)', overflowY: 'auto' }}>
        <span style={{ color: 'var(--text-muted)' }}>{tKey('dm.quote.fromLabel')}</span>
        {/* 【任务58 口径】兜底显示「未知会员」，绝不回落成会员ID */}
        <b style={{ color: 'var(--text)' }}>{props.fromLabel || tKey('common.unknownMember')}</b>
        <span style={{ color: 'var(--text-muted)' }}>{tKey('dm.quote.colon')}</span>
        <span style={{ color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{props.preview || tKey('dm.quote.noContent')}</span>
      </div>

      {/* 失败原因：留在弹层内，用户看得见，也不会因为弹层自动关闭而丢掉 */}
      {props.errorText && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '8px 12px', fontSize: 12, lineHeight: 1.6, color: 'var(--danger-text, #b91c1c)', background: 'var(--tint-red, rgba(239,68,68,0.08))', flexShrink: 0 }}>
          <span style={{ display: 'inline-flex', flexShrink: 0, marginTop: 1 }}><IconWarn /></span>
          <span style={{ flex: 1, minWidth: 0 }}>{props.errorText}</span>
        </div>
      )}
      {/* 中性提示（已追加过 / 未重复塞两遍等）：不是故障，用中性底色，避免把提示伪装成报错 */}
      {props.hintText && (
        <div style={{ padding: '8px 12px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
          {props.hintText}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {targets.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, padding: '10px 0' }}>
            {tKey('dm.quote.emptyTargets')}
          </div>
        )}
        {targets.map((t) => {
          // 【i18n 期1】空标题显示「未命名会话」词条，**不回落会话 id**（口径与改前一致）
          const label = (t.title ?? '').trim() || tKey('common.unnamedSession')
          return (
            <div
              key={t.id}
              onClick={() => { if (!props.pending) props.onPick(t) }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 10px',
                borderRadius: 8,
                cursor: props.pending ? 'not-allowed' : 'pointer',
                opacity: props.pending ? 0.55 : 1,
                background: t.current ? 'var(--tint-blue-soft, var(--bg-app))' : 'var(--bg-app)',
                border: t.current ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                minWidth: 0,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{label}</span>
                  {t.current && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--accent)', color: '#fff', flexShrink: 0 }}>{tKey('dm.quote.badgeCurrent')}</span>}
                  {t.busy && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--tint-orange, var(--tint-red))', color: 'var(--warning-text, var(--text-secondary))', flexShrink: 0 }}>{tKey('dm.quote.badgeBusy')}</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {t.lastActiveAt ? tKey('dm.quote.lastActive', { time: fmtListTime(t.lastActiveAt) }) : tKey('dm.quote.noActivity')}
                </div>
              </div>
              <span style={{ fontSize: 11, color: 'var(--accent)', flexShrink: 0 }}>{tKey('dm.quote.pickHere')}</span>
            </div>
          )
        })}
      </div>

      {/* 红线说明：本动作只把原文追加进目标输入框，不会自动发送 —— 这句话必须常驻可见，不能只写在 tooltip 里 */}
      <div style={{ padding: '8px 12px 10px', borderTop: '1px solid var(--border-soft)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0 }}>{tKey('dm.quote.footer')}</span>
        <button onClick={props.onClose} style={btn('var(--bg-panel)', 'var(--text)', '1px solid var(--border-strong)')}>{tKey('common.cancel')}</button>
      </div>
    </div>
  )
}
