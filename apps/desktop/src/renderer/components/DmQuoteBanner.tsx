import * as React from 'react'
import { IconClose } from './icons'
import type { DmQuotePayload } from '../types'
import { t, getLocale } from '../../shared/i18n'
// 【期5B-补漏】本文件原先自己抄了第三份「名字等于 id 就当无真名」的判定（displayNameOfQuote），
// 现在统一用 shared 那一份 —— 三份实现必然漂，这是本项目反复踩的坑。
import { displayNameOf } from '../../shared/member-display'
import { useLocaleSync } from '../locale'

/**
 * 私信「引用到会话」的来源提示条（渲染在输入框上方）。
 *
 * 为什么需要它：私信原文由用户显式点击「引用到会话」后**追加进输入框**，
 * 一旦进了输入框就和用户自己打的字完全同构，事后无法区分来源。
 * 因此来源信息（谁发的、msgId、时间）单独用这条提示条承载，
 * 而不是拼进正文（拼进正文会被 resendMessage / editResend 当作真实用户指令重放进模型上下文），
 * 也不给消息流 ChatItem 加 source 字段（同理，且会污染历史持久化结构）。
 *
 * 【安全红线】本组件纯展示：不发送、不触发执行、不影响审批，只能被用户手动关闭。
 */
export interface DmQuoteBannerProps {
  quote: DmQuotePayload
  onDismiss: () => void
}

function fmtQuoteTime(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString(getLocale() === 'en-US' ? 'en-US' : undefined)
  } catch {
    return ''
  }
}

/**
 * 【2026-09-04 用户要求：私信界面不再显示 memberId】
 * 来源名由主进程拼装。【期5B-补漏】主进程已不再把 memberId 当名字塞进载荷，但**历史落盘数据**
 * （升级前写的 peerName / fromName）里仍可能是 id，所以这里仍按 fromMemberId 反查一次挡历史数据；
 * 判定本体用 shared/member-display 那一份，不再本地重写。仅影响显示，quote 数据本身未改。
 */
function displayNameOfQuote(q: DmQuotePayload): string {
  return displayNameOf(q.fromName, q.fromMemberId)
}

export function DmQuoteBanner(p: DmQuoteBannerProps): React.JSX.Element {
  // 谁取词谁订阅：displayNameOfQuote 是渲染期取词的 helper（期3 supervisorArgsSummary 同款），
  // 它自己不订阅，靠本组件订阅后重新调用它取到最新语言。
  useLocaleSync()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        marginBottom: 6,
        borderRadius: 8,
        border: '1px solid var(--border-soft)',
        // 用中性底色 + 左侧强调条：明确表达「这是被引用的外部内容」，不是本地用户已发送的话
        background: 'var(--bg-sidebar)',
        borderLeft: '3px solid var(--accent)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        lineHeight: 1.6,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        {t('dm.quote.bannerAdded')}{t('common.sepMiddle')}{t('dm.quote.fromLabel')}<b style={{ color: 'var(--text)' }}>{displayNameOfQuote(p.quote)}</b>
        {p.quote.ts > 0 && (
          <span style={{ opacity: 0.75 }}>{t('dm.quote.bannerTime', { time: fmtQuoteTime(p.quote.ts) })}</span>
        )}
        <span style={{ opacity: 0.75 }}>{t('common.sepMiddle')}{t('dm.quote.bannerNoAuto')}</span>
      </span>
      <button
        onClick={p.onDismiss}
        title={t('dm.quote.bannerDismissTip')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: 5,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <IconClose />
      </button>
    </div>
  )
}
