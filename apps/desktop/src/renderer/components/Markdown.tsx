import { useEffect, useRef, useState } from 'react'
import { toPng } from 'html-to-image'
import { copyText } from './ui'

function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map((c) => (typeof c === 'string' ? c : '')).join('')
  return ''
}

/** 代码块：深色高亮 + 右上角「复制代码」按钮（点击后对勾反馈） */
export function CodeBlock({ children }: { children?: React.ReactNode }) {
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
        {copied ? '✓ 已复制' : '复制'}
      </button>
      <pre style={{ background: '#282c34', color: '#abb2bf', padding: '12px 12px 12px 12px', borderRadius: 8, overflowX: 'auto', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
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
        正在渲染图表…
      </div>
    )
  }
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => void copyAsImage()}
        title="复制图表为图片"
        style={{ position: 'absolute', top: 14, right: 14, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-panel)', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer', zIndex: 2 }}
      >
        {copied ? '✓ 已复制' : '复制图表'}
      </button>
      <div
        ref={containerRef}
        style={{ margin: '8px 0', padding: '8px', borderRadius: 8, background: 'var(--bg-hover)', overflowX: 'auto', textAlign: 'center' }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

/** 图片点击预览回调（模块级可变引用）：让 components 对象保持稳定引用，避免每次渲染重建导致 ReactMarkdown 子树（代码块/图表）重挂载闪屏 */
let latestImageClick: ((url: string) => void) | undefined

function MarkdownCode(props: { className?: string; children?: React.ReactNode }): React.JSX.Element {
  const cls = props.className ?? ''
  const lang = /language-([\w-]+)/.exec(cls)?.[1]
  if (!cls || !lang) {
    return (
      <code style={{ background: 'var(--bg-hover)', padding: '2px 5px', borderRadius: 4, fontSize: '0.9em', fontFamily: 'ui-monospace, monospace' }}>
        {props.children}
      </code>
    )
  }
  if (lang === 'mermaid') {
    return <MermaidBlock code={extractCodeText(props.children)} />
  }
  return <CodeBlock>{props.children}</CodeBlock>
}

function MarkdownLink(props: { href?: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <a href={props.href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
      {props.children}
    </a>
  )
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

/** 稳定引用的 components（模块级只创建一次），避免每次 render 新建组件导致代码块/Mermaid 图表子树重挂载（输入时闪屏的根因） */
const MARKDOWN_COMPONENTS = {
  code: MarkdownCode,
  a: MarkdownLink,
  img: MarkdownImage,
}

/** 生成 react-markdown 的 components 配置（代码块高亮 / mermaid 图表 / 行内代码 / 链接 / 图片宽度限制） */
export function makeMarkdownComponents(onImageClick?: (url: string) => void) {
  latestImageClick = onImageClick
  return MARKDOWN_COMPONENTS
}
