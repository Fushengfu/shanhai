import { useEffect, useRef, useState } from 'react'
import { toPng } from 'html-to-image'
import { copyText } from './ui'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'

function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map((c) => (typeof c === 'string' ? c : '')).join('')
  return ''
}

/** 代码块：深色高亮 + 右上角「复制代码」按钮（点击后对勾反馈） */
export function CodeBlock({ children }: { children?: React.ReactNode }) {
  useLocaleSync()
  const [copied, setCopied] = useState(false)
  const text = extractCodeText(children)
  return (
    <div style={{ position: 'relative', margin: '8px 0' }}>
      <button
        onClick={() => {
          void copyText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }}
        style={{ position: 'absolute', top: 8, right: 8, padding: '2px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: '#abb2bf', fontSize: 11, cursor: 'pointer', zIndex: 2 }}
      >
        {copied ? t('chat.md.copied') : t('chat.md.copy')}
      </button>
      <pre style={{ background: '#282c34', color: '#abb2bf', padding: '12px 12px 12px 12px', borderRadius: 8, overflowX: 'auto', maxWidth: '100%', boxSizing: 'border-box', whiteSpace: 'pre', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
        <code style={{ fontFamily: 'ui-monospace, monospace' }}>{children}</code>
      </pre>
    </div>
  )
}

/** 判断当前是否为暗色主题（mermaid 图表配色跟随亮/暗主题） */
function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

/**
 * Mermaid 图表块：把 ```mermaid 代码块渲染成 SVG 图表（懒加载 mermaid，避免主 bundle 暴涨）。
 * 渲染成功显示 SVG；渲染中显示占位；渲染失败回退为普通代码块，不阻塞正文。
 */
export function MermaidBlock({ code }: { code: string }) {
  // 【期4C 谁取词谁订阅】渲染期取词（占位/按钮/对勾），与 CodeBlock 同理各自挂订阅
  useLocaleSync()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        // loose 允许渲染更多图表类型（本地桌面应用 + AI 输出场景，权衡下放宽安全性）
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: isDarkTheme() ? 'dark' : 'default',
          fontFamily: 'inherit',
        })
        const { svg: out } = await mermaid.render(idRef.current, code)
        if (!cancelled) setSvg(out)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code])

  /** 把当前图表单独截图成 PNG 写入剪贴板（html-to-image 精确还原，2x 高清） */
  const copyAsImage = async (): Promise<void> => {
    const el = containerRef.current
    if (!el) return
    try {
      const dataUrl = await toPng(el, { pixelRatio: 2, backgroundColor: 'var(--bg-panel)' })
      const blob = await (await fetch(dataUrl)).blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // 忽略复制失败
    }
  }

  if (error) return <CodeBlock>{code}</CodeBlock>
  if (!svg) {
    return (
      <div style={{ margin: '8px 0', padding: '16px', borderRadius: 8, background: 'var(--bg-hover)', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
        {t('chat.md.rendering')}
      </div>
    )
  }
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => void copyAsImage()}
        title={t('chat.md.copyImageTitle')}
        style={{ position: 'absolute', top: 14, right: 14, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer', zIndex: 2 }}
      >
        {copied ? t('chat.md.copied') : t('chat.md.copyChart')}
      </button>
      <div
        ref={containerRef}
        style={{ margin: '8px 0', padding: '8px', borderRadius: 8, background: 'var(--bg-hover)', overflowX: 'auto', textAlign: 'center' }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

/**
 * Markdown 渲染语境：'panel' 浅色气泡（AI 回复 / 私信对方，深字浅底），
 * 'accent' 强调色气泡（用户消息 / 私信自己，白字蓝底）。
 * 行内代码 / 链接 / 表格据此换配色——accent 气泡里 var(--accent) 与背景同色会看不见、var(--text) 深字在蓝底上不可读。
 */
export type MarkdownTone = 'panel' | 'accent'

/** 图片点击预览回调（模块级可变引用）：让 components 对象保持稳定引用，避免每次渲染重建导致 ReactMarkdown 子树（代码块/图表）重挂载闪屏 */
let latestImageClick: ((url: string) => void) | undefined

/** 行内代码 / 代码块 / Mermaid：tone 只影响行内代码配色（accent 蓝底用半透明白，panel 用 bg-hover），代码块固定深色两种语境通用 */
function makeCode(tone: MarkdownTone) {
  return function MarkdownCode(props: { className?: string; children?: React.ReactNode }): React.JSX.Element {
    const cls = props.className ?? ''
    const lang = /language-([\w-]+)/.exec(cls)?.[1]
    if (!cls || !lang) {
      const style: React.CSSProperties =
        tone === 'accent'
          ? { background: 'rgba(255,255,255,0.18)', color: '#fff', padding: '2px 5px', borderRadius: 4, fontSize: '0.9em', fontFamily: 'ui-monospace, monospace' }
          : { background: 'var(--bg-hover)', padding: '2px 5px', borderRadius: 4, fontSize: '0.9em', fontFamily: 'ui-monospace, monospace' }
      return (
        <code style={style}>
          {props.children}
        </code>
      )
    }
    if (lang === 'mermaid') {
      return <MermaidBlock code={extractCodeText(props.children)} />
    }
    return <CodeBlock>{props.children}</CodeBlock>
  }
}

/** 链接：accent 蓝底里 var(--accent) 与背景同色看不见，改白色+下划线；panel 保持 var(--accent) */
function makeLink(tone: MarkdownTone) {
  return function MarkdownLink(props: { href?: string; children?: React.ReactNode }): React.JSX.Element {
    const style: React.CSSProperties =
      tone === 'accent' ? { color: '#fff', textDecoration: 'underline' } : { color: 'var(--accent)' }
    return (
      <a href={props.href} target="_blank" rel="noreferrer" style={style}>
        {props.children}
      </a>
    )
  }
}

function MarkdownImage(props: { src?: string; alt?: string }): React.JSX.Element {
  return (
    <img
      src={props.src}
      alt={props.alt}
      onClick={() => {
        if (props.src && latestImageClick) latestImageClick(props.src)
      }}
      style={{ maxWidth: '100%', height: 'auto', borderRadius: 8, display: 'block', cursor: latestImageClick ? 'zoom-in' : 'default' }}
    />
  )
}

/** 表格外层：加横向滚动容器，宽表格不会被气泡 maxWidth 挤压换行 */
function MarkdownTable(props: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ overflowX: 'auto', margin: '10px 0' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: '100%', width: '100%' }}>{props.children}</table>
    </div>
  )
}

/** 表头单元格：背景底色 + 边框 + 加粗左对齐，与普通单元格形成视觉区分。accent 蓝底改半透明白底+白字 */
function makeTh(tone: MarkdownTone) {
  return function MarkdownTh(props: { children?: React.ReactNode }): React.JSX.Element {
    const style: React.CSSProperties =
      tone === 'accent'
        ? { border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.12)', padding: '6px 12px', textAlign: 'left', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' }
        : { border: '1px solid var(--border-strong)', background: 'var(--bg-hover)', padding: '6px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }
    return <th style={style}>{props.children}</th>
  }
}

/** 表格单元格：边框 + 内边距 + 顶部对齐。accent 蓝底改白字+半透明白边框 */
function makeTd(tone: MarkdownTone) {
  return function MarkdownTd(props: { children?: React.ReactNode }): React.JSX.Element {
    const style: React.CSSProperties =
      tone === 'accent'
        ? { border: '1px solid rgba(255,255,255,0.35)', padding: '6px 12px', color: '#fff', verticalAlign: 'top' }
        : { border: '1px solid var(--border-strong)', padding: '6px 12px', color: 'var(--text)', verticalAlign: 'top' }
    return <td style={style}>{props.children}</td>
  }
}

/** 稳定引用的 components：按 tone 各缓存一份，避免每次 render 新建组件导致代码块/Mermaid 图表子树重挂载（输入时闪屏的根因） */
const COMPONENTS_CACHE = new Map<MarkdownTone, ReturnType<typeof buildComponents>>()

function buildComponents(tone: MarkdownTone) {
  return {
    code: makeCode(tone),
    a: makeLink(tone),
    img: MarkdownImage,
    table: MarkdownTable,
    th: makeTh(tone),
    td: makeTd(tone),
  }
}

/**
 * 生成 react-markdown 的 components 配置（代码块高亮 / mermaid 图表 / 行内代码 / 链接 / 图片宽度限制）。
 * @param tone 'panel' = 浅色气泡（AI 回复 / 私信对方），'accent' = 强调色气泡（用户消息 / 私信自己）
 */
export function makeMarkdownComponents(onImageClick?: (url: string) => void, tone: MarkdownTone = 'panel') {
  latestImageClick = onImageClick
  let c = COMPONENTS_CACHE.get(tone)
  if (!c) {
    c = buildComponents(tone)
    COMPONENTS_CACHE.set(tone, c)
  }
  return c
}

/** 树结构 / 目录树 / 框线图用到的 box-drawing 字符（U+2500 系列），用于识别「未用代码块包裹的等宽树形文本」 */
const TREE_CHARS = new Set('─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬')

function hasTreeChar(line: string): boolean {
  for (const ch of line) {
    if (TREE_CHARS.has(ch)) return true
  }
  return false
}

/**
 * 把「未包裹在代码块里的树结构 / 框线图段落」自动转成围栏代码块。
 * 根因：Markdown 会把段内的单个换行折叠成空格，导致树结构多行挤成一行、超长溢出气泡；
 * 树结构需要等宽字体 + 保留换行（+ 必要时横向滚动）才能正确显示，因此转成代码块交给 CodeBlock。
 * 规则：
 * - 只处理围栏代码块（``` / ~~~）之外的行，围栏内的内容原样保留；
 * - 连续 ≥2 个含 box-drawing 字符的行（允许中间夹空行）视为一个树块，包裹成 ``` 代码块；
 * - 单个含 box-drawing 字符的行不作为树块处理（避免误伤 markdown 分隔线等）。
 */
/** 系统内置标签（*-record 结尾）整段包裹检测：<prefix-record>…</suffix-record>，prefix 与 suffix 同一标签名 */
const WRAPPED_RECORD_TAG_RE = /^<([a-zA-Z][a-zA-Z0-9-]*-record)\s*>([\s\S]*)<\/\1\s*>$/

/**
 * 渲染层保守去壳：仅当整段文本被「单个 *-record 标签」完整包裹（开头 <xxx-record>、结尾 </xxx-record>，
 * 且是同一对标签）时，剥离外层标签返回中间正文；否则原样返回。
 * 与内核层「任意出现即清洗到日志」不同，这里是「整段包裹才去壳」，避免误伤用户正常正文 / 转义文本 / 普通 HTML 标签。
 */
export function stripWrappedRecordTag(text: string): string {
  if (!text) return text
  const trimmed = text.trim()
  const m = WRAPPED_RECORD_TAG_RE.exec(trimmed)
  if (!m) return text
  return m[2] ?? text
}

export function normalizeTreeBlocks(markdown: string): string {
  if (!markdown) return markdown
  const lines = markdown.split('\n')
  const out: string[] = []
  let i = 0
  let fenceOpen = false
  let fenceChar = ''

  // noUncheckedIndexedAccess 下 lines[idx] 为 string | undefined，统一兜底为 ''（i 恒 < length，实际不会命中）
  const lineAt = (idx: number): string => lines[idx] ?? ''

  while (i < lines.length) {
    const line = lineAt(i)

    if (fenceOpen) {
      out.push(line)
      const t = line.trimStart()
      if (fenceChar === '`' ? t.startsWith('```') : t.startsWith('~~~')) fenceOpen = false
      i++
      continue
    }

    const openMatch = /^\s*(```+|~~~+)/.exec(line)
    if (openMatch && openMatch[1]) {
      fenceOpen = true
      fenceChar = openMatch[1].charAt(0)
      out.push(line)
      i++
      continue
    }

    if (hasTreeChar(line.trimStart())) {
      const block: string[] = []
      let j = i
      while (j < lines.length) {
        const l = lineAt(j)
        if (hasTreeChar(l.trimStart())) {
          block.push(l)
          j++
        } else if (l.trim() === '' && j + 1 < lines.length && hasTreeChar(lineAt(j + 1).trimStart())) {
          block.push(l)
          j++
        } else {
          break
        }
      }
      const nonEmpty = block.filter((l) => l.trim() !== '')
      if (nonEmpty.length >= 2) {
        out.push('```')
        out.push(...block)
        out.push('```')
        i = j
        continue
      }
    }

    out.push(line)
    i++
  }

  return out.join('\n')
}
