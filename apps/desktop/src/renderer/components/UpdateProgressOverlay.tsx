import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUpdateDownloadProgress } from '../types'
import { formatBytes } from './ui'

/**
 * 更新安装包下载进度浮层（应用内可见反馈）。
 *
 * 数据来源：主进程在 downloadUpdatePackage 里把进度广播到「所有窗口」
 * （通道 app:update-download-progress），因此用户当前看到的任意一个内容窗口
 * 都会显示同一份进度；中途新开的窗口通过 getUpdateDownloadProgress() 拉一次快照补齐。
 *
 * 收尾保证：主进程在 done 事件里必定发送 completed / failed / cancelled 三种终态之一，
 * 本组件收到终态后把进度条锁到终值并显示对应状态文案，不会停在 99%。
 * completed / cancelled 会在若干秒后自动收起；failed 保留到用户手动关闭（便于看清原因）。
 */

/** 各阶段的标题文案 */
const PHASE_TITLE: Record<AppUpdateDownloadProgress['phase'], string> = {
  pending: '准备下载更新',
  downloading: '正在下载更新',
  verifying: '正在校验安装包',
  completed: '更新包已就绪',
  failed: '更新下载失败',
  cancelled: '更新下载已取消',
}

/** 终态自动收起延时（ms）：completed 留久一点让用户看见，cancelled 快速收起 */
const AUTO_DISMISS_MS: Partial<Record<AppUpdateDownloadProgress['phase'], number>> = {
  completed: 12_000,
  cancelled: 5_000,
}

function isTerminal(phase: AppUpdateDownloadProgress['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled'
}

function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function UpdateProgressOverlay(): React.JSX.Element | null {
  const [progress, setProgress] = useState<AppUpdateDownloadProgress | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 订阅主进程进度广播
  useEffect(() => {
    const unsub = window.shanhai?.onUpdateDownloadProgress((p) => {
      setDismissed(false)
      setProgress(p)
    })
    return () => unsub?.()
  }, [])

  // 中途挂载（例如下载过程中才打开设置窗口）：拉一次快照补齐
  useEffect(() => {
    void window.shanhai
      ?.getUpdateDownloadProgress()
      .then((p) => {
        if (p) setProgress((prev) => (!prev || p.updatedAt >= prev.updatedAt ? p : prev))
      })
      .catch(() => undefined)
  }, [])

  // 终态自动收起（failed 不自动收起，留给用户看清原因后手动关）
  useEffect(() => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current)
      dismissTimer.current = null
    }
    if (!progress || !isTerminal(progress.phase)) return
    const ms = AUTO_DISMISS_MS[progress.phase]
    if (!ms) return
    dismissTimer.current = setTimeout(() => {
      setDismissed(true)
      setProgress(null)
    }, ms)
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
    }
  }, [progress])

  const cancel = useCallback(() => {
    void window.shanhai?.cancelUpdateDownload().catch(() => undefined)
  }, [])

  const close = useCallback(() => {
    setDismissed(true)
    setProgress(null)
  }, [])

  if (!progress || dismissed) return null

  const known = progress.percent >= 0
  const shownPercent = known ? Math.max(0, Math.min(100, progress.percent)) : 0
  const failed = progress.phase === 'failed'
  const done = progress.phase === 'completed'
  const cancelled = progress.phase === 'cancelled'
  const accent = failed ? 'var(--danger-text)' : done ? 'var(--accent)' : 'var(--accent)'
  const total = progress.totalBytes > 0 ? progress.totalBytes : 0

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        width: 320,
        maxWidth: 'calc(100vw - 32px)',
        padding: '12px 14px',
        borderRadius: 12,
        border: `1px solid ${failed ? 'var(--tint-red-strong)' : 'var(--border-soft)'}`,
        background: 'var(--bg-panel)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
        zIndex: 2147483000,
        fontSize: 12,
        color: 'var(--text)',
      }}
    >
      {/* 标题 + 关闭 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          {PHASE_TITLE[progress.phase]}
          {progress.latestVersion ? ` v${progress.latestVersion}` : ''}
        </div>
        <button
          onClick={close}
          title="关闭"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 2,
          }}
        >
          ×
        </button>
      </div>

      {/* 进度条：总量未知时走不确定态动画 */}
      <div
        style={{
          marginTop: 10,
          height: 6,
          borderRadius: 999,
          background: 'var(--bg-sidebar)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: known ? `${shownPercent}%` : '40%',
            borderRadius: 999,
            background: accent,
            transition: 'width 240ms ease',
            animation: known ? 'none' : 'shanhai-update-indeterminate 1.1s ease-in-out infinite',
          }}
        />
      </div>

      {/* 百分比 / 已下载 / 速度 */}
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: accent }}>{known ? `${shownPercent.toFixed(1)}%` : '—'}</span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {formatBytes(progress.receivedBytes)}
          {total > 0 ? ` / ${formatBytes(total)}` : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{formatSpeed(progress.bytesPerSecond)}</span>
      </div>

      {/* 文件名 + 保存路径 */}
      {!isTerminal(progress.phase) && progress.fileName ? (
        <div
          style={{
            marginTop: 6,
            color: 'var(--text-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={progress.savePath || progress.fileName}
        >
          {progress.fileName}
        </div>
      ) : null}

      {/* 状态/错误文案 */}
      {progress.message ? (
        <div
          style={{
            marginTop: 6,
            lineHeight: 1.5,
            color: failed ? 'var(--danger-text)' : 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: failed ? 96 : undefined,
            overflowY: failed ? 'auto' : undefined,
          }}
        >
          {progress.message}
        </div>
      ) : null}

      {/* 终态补充说明 */}
      {done ? <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>请在弹出的对话框中选择「立即安装」，或稍后手动打开安装包。</div> : null}
      {cancelled ? <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>已取消下载，残留文件已清理。</div> : null}

      {/* 操作：下载中可取消；失败/完成可关闭 */}
      <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {!isTerminal(progress.phase) ? (
          <button
            onClick={cancel}
            style={{
              padding: '4px 12px',
              fontSize: 12,
              borderRadius: 6,
              border: '1px solid var(--border-soft)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            取消下载
          </button>
        ) : null}
        <button
          onClick={close}
          style={{
            padding: '4px 12px',
            fontSize: 12,
            borderRadius: 6,
            border: 'none',
            background: 'var(--accent)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          {failed ? '知道了' : '关闭'}
        </button>
      </div>

      {/* 不确定态动画（一次性注入，避免依赖全局 CSS） */}
      <style>{`@keyframes shanhai-update-indeterminate { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }`}</style>
    </div>
  )
}
