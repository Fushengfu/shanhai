import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { UserTerminalInfo } from '../types'
import { IconClose, IconPlus, IconTerminal } from './icons'
import { WindowTitleBar } from './WindowTitleBar'

/** 从完整 terminalId 提取短名（去掉会话前缀），供标签页显示 */
function shortName(terminalId: string, sessionId: string): string {
  return terminalId.startsWith(`${sessionId}-`) ? terminalId.slice(sessionId.length + 1) : terminalId
}

/** 终端配色（亮色）：浅底深字，与亮色主题协调 */
const LIGHT_TERM_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#333333',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  selectionForeground: '#333333',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
}

/** 终端配色（暗色）：深底浅字，与暗色主题协调 */
const DARK_TERM_THEME: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
}

/** 读取当前主题对应的终端配色 */
function currentTermTheme(): ITheme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? DARK_TERM_THEME : LIGHT_TERM_THEME
}

/** 单个终端视图：独立 xterm 实例，负责输入/输出/resize 与后端 PTY 双向桥接 */
function TerminalView({ sessionId, terminalId, active }: { sessionId: string; terminalId: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // 创建 xterm 实例（只依赖 sessionId/terminalId；active 变化不重建实例，只重新 fit）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: currentTermTheme(),
      scrollback: 2000,
      convertEol: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    // 初始 fit（非激活 tab 为 display:none，可能得 0 尺寸，无妨，激活时再 fit）
    try {
      fit.fit()
    } catch {
      // 尺寸未就绪，忽略
    }

    // 输出：主进程 PTY → xterm（按 sessionId + terminalId 过滤）
    const offOutput = window.shanhai?.onUserTerminalOutput((sid, tid, data) => {
      if (sid === sessionId && tid === terminalId) {
        try {
          term.write(data)
        } catch {
          // 实例已销毁
        }
      }
    })
    // 输入：xterm 按键 → 主进程 PTY 原始写入
    const inputDisp = term.onData((data) => {
      window.shanhai?.userTerminalWrite(sessionId, terminalId, data)
    })
    // 复制选中文本到剪贴板（右键 / Cmd+C 共用；Electron clipboard 优先，file:// 下 navigator.clipboard 可能不可用）
    const copySelection = (): void => {
      const sel = term.getSelection()
      if (!sel) return
      try {
        if (window.shanhai?.clipboardWriteText) {
          window.shanhai.clipboardWriteText(sel)
          return
        }
      } catch {
        // 忽略，走下一级回退
      }
      void navigator.clipboard.writeText(sel).catch(() => {
        // 剪贴板 API 失败时回退 document.execCommand（兼容旧环境）
        const ta = document.createElement('textarea')
        ta.value = sel
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      })
    }
    // 快捷键：Cmd/Ctrl+C 复制选中，Cmd/Ctrl+V 粘贴剪贴板（handler 随 term.dispose 一并清理）
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        copySelection()
        return false
      }
      if (mod && e.key.toLowerCase() === 'v') {
        let text = ''
        try {
          if (window.shanhai?.clipboardReadText) text = window.shanhai.clipboardReadText()
        } catch {
          // 忽略
        }
        if (text) {
          term.paste(text)
        } else {
          void navigator.clipboard.readText().then((t) => {
            if (t) term.paste(t)
          }).catch(() => undefined)
        }
        return false
      }
      return true
    })
    // 右键：有选中则复制，否则展示浏览器默认菜单（可粘贴）
    const onContextMenu = (e: MouseEvent): void => {
      const sel = term.getSelection()
      if (sel) {
        e.preventDefault()
        copySelection()
      }
    }
    container.addEventListener('contextmenu', onContextMenu)
    // 尺寸：fit 后同步 cols/rows 到后端 PTY
    const resizeDisp = term.onResize(({ cols, rows }) => {
      window.shanhai?.userTerminalResize(sessionId, terminalId, cols, rows)
    })
    // 容器尺寸变化（面板/窗口 resize）时重新 fit
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        try {
          fitRef.current?.fit()
        } catch {
          // ignore
        }
      })
      observer.observe(container)
    }

    // 主题（亮/暗）切换时：更新终端配色并重绘，使终端跟随主题显示
    let themeObserver: MutationObserver | null = null
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => {
        if (!termRef.current) return
        try {
          termRef.current.options.theme = currentTermTheme()
          termRef.current.refresh(0, termRef.current.rows - 1)
        } catch {
          // ignore
        }
      })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    }

    return () => {
      offOutput?.()
      inputDisp.dispose()
      container.removeEventListener('contextmenu', onContextMenu)
      resizeDisp.dispose()
      observer?.disconnect()
      themeObserver?.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, terminalId])

  // 激活（tab 切回）时重新 fit，等 display 切换生效后再测量
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
    })
  }, [active])

  return <div ref={containerRef} style={{ width: '100%', height: '100%', padding: '4px 8px' }} />
}

/** 会话级交互式终端面板：底部可折叠、多标签多开，用户手动执行命令。
 * 通过 props 注入会话与开关状态（panel 模式由 TerminalPlugin 传 useUIContext，window 模式由 AppWindow 传 store）。 */
export function TerminalPanel({ sessionId, open, onToggle, onClose, variant = 'panel' }: { sessionId: string; open: boolean; onToggle?: () => void; onClose?: () => void; variant?: 'panel' | 'window' }) {
  const [terminals, setTerminals] = useState<UserTerminalInfo[]>([])
  const [activeId, setActiveId] = useState('')
  // 面板高度：支持顶部把手上下拖动调整（最小 120，最大 600）
  const [panelHeight, setPanelHeight] = useState(260)
  const draggingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(260)

  // 拖动调整高度：按住把手上下拖动，实时更新面板高度
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      const dy = startYRef.current - e.clientY
      setPanelHeight(Math.min(600, Math.max(120, startHeightRef.current + dy)))
    }
    const onUp = (): void => {
      draggingRef.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const beginResize = (e: React.MouseEvent): void => {
    draggingRef.current = true
    startYRef.current = e.clientY
    startHeightRef.current = panelHeight
    e.preventDefault()
  }

  const loadTerminals = useCallback(async (sid: string): Promise<UserTerminalInfo[]> => {
    const list = (await window.shanhai?.userTerminalList(sid)) ?? []
    setTerminals(list)
    setActiveId((prev) => (list.some((t) => t.terminalId === prev) ? prev : (list[0]?.terminalId ?? '')))
    return list
  }, [])

  const createTerminal = useCallback(async () => {
    if (!sessionId) return
    const id = await window.shanhai?.userTerminalCreate(sessionId, '终端')
    if (!id) return
    setTerminals((prev) => [...prev, { terminalId: id, name: '终端' }])
    setActiveId(id)
  }, [sessionId])

  // 会话切换 / 面板打开时：加载该会话终端列表；面板打开但该会话确无终端时懒创建第一个（会话级隔离）
  useEffect(() => {
    if (!sessionId) {
      setTerminals([])
      setActiveId('')
      return
    }
    let cancelled = false
    void loadTerminals(sessionId).then((list) => {
      if (cancelled) return
      // 打开面板且该会话确实没有终端 → 懒创建第一个（用 list 判断，避免加载期间误判为空）
      if (open && list.length === 0) {
        void createTerminal()
      }
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, open, loadTerminals, createTerminal])

  async function closeTerminal(terminalId: string): Promise<void> {
    await window.shanhai?.userTerminalClose(sessionId, terminalId)
    setTerminals((prev) => {
      const next = prev.filter((t) => t.terminalId !== terminalId)
      setActiveId((cur) => (cur === terminalId ? (next[0]?.terminalId ?? '') : cur))
      return next
    })
  }

  if (!open) return null

  return (
    <div
      style={
        {
          ...(variant === 'window'
            ? { height: '100vh', flex: 1 }
            : { borderTop: '1px solid var(--border)', height: panelHeight, flexShrink: 0 }),
          background: 'var(--bg-app)',
          display: 'flex',
          flexDirection: 'column',
        } as React.CSSProperties
      }
    >
      {/* 顶部：window 模式显示统一标题栏（可拖动 + 关闭窗口）；panel 模式显示拖动把手（上下调整高度） */}
      {variant === 'window' ? (
        <WindowTitleBar icon={<IconTerminal />} title="终端" onClose={() => onClose?.()} />
      ) : (
        <div
          onMouseDown={beginResize}
          title="拖动调整终端高度"
          style={{
            height: 10,
            cursor: 'ns-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            userSelect: 'none',
            background: 'transparent',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--tint-blue-soft)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <div style={{ width: 48, height: 4, borderRadius: 2, background: 'var(--border-strong)' }} />
        </div>
      )}
      {/* 终端标签栏：多开 + 新建 + 收起 */}
      <div
        style={
          {
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            flexShrink: 0,
          } as React.CSSProperties
        }
      >
        <span style={{ display: 'inline-flex', color: 'var(--text-secondary)', flexShrink: 0 }}>
          <IconTerminal />
        </span>
        {terminals.map((t) => {
          const isActive = t.terminalId === activeId
          return (
            <div
              key={t.terminalId}
              onClick={() => setActiveId(t.terminalId)}
              title={t.name || shortName(t.terminalId, sessionId)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-soft)',
                background: isActive ? 'var(--bg-sidebar)' : 'transparent',
                color: isActive ? 'var(--text)' : 'var(--text-muted)',
                fontSize: 12,
                cursor: 'pointer',
                maxWidth: 160,
                userSelect: 'none',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(t.terminalId, sessionId)}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTerminal(t.terminalId)
                }}
                title="关闭终端"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0, lineHeight: 1, flexShrink: 0 }}
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          onClick={() => void createTerminal()}
          title="新建终端"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
        >
          <IconPlus />
        </button>
        <span style={{ flex: 1 }} />
        {variant === 'panel' && (
          <button
            onClick={() => onToggle?.()}
            title="收起终端"
            style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            <IconClose />
          </button>
        )}
      </div>

      {/* 终端内容区：所有实例保持挂载，非激活的用 display:none 隐藏（保留 scrollback） */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {terminals.map((t) => (
          <div
            key={t.terminalId}
            style={{ display: t.terminalId === activeId ? 'flex' : 'none', flex: 1, minWidth: 0, minHeight: 0 }}
          >
            <TerminalView sessionId={sessionId} terminalId={t.terminalId} active={t.terminalId === activeId} />
          </div>
        ))}
        {terminals.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            点击「+」新建终端
          </div>
        )}
      </div>
    </div>
  )
}
