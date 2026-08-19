import { useState } from 'react'
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

/** 生成 react-markdown 的 components 配置（代码块高亮 / 行内代码 / 链接 / 图片宽度限制） */
export function makeMarkdownComponents(onImageClick?: (url: string) => void) {
  return {
    code(props: { className?: string; children?: React.ReactNode }) {
      const hasLang = /language-[\w-]+/.test(props.className ?? '')
      if (!props.className || !hasLang) {
        return (
          <code style={{ background: '#f0f0f0', padding: '2px 5px', borderRadius: 4, fontSize: '0.9em', fontFamily: 'ui-monospace, monospace' }}>
            {props.children}
          </code>
        )
      }
      return <CodeBlock>{props.children}</CodeBlock>
    },
    a(props: { href?: string; children?: React.ReactNode }) {
      return (
        <a href={props.href} target="_blank" rel="noreferrer" style={{ color: '#1677ff' }}>
          {props.children}
        </a>
      )
    },
    img(props: { src?: string; alt?: string }) {
      return (
        <img
          src={props.src}
          alt={props.alt}
          onClick={() => props.src && onImageClick?.(props.src)}
          style={{ maxWidth: '100%', height: 'auto', borderRadius: 8, display: 'block', cursor: onImageClick ? 'zoom-in' : 'default' }}
        />
      )
    },
  }
}
