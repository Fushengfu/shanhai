import * as React from 'react'

/** 气泡样式（助手/用户消息的通用底样） */
export function bubble(bg: string, color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '8px 12px',
    borderRadius: 12,
    background: bg,
    color,
    maxWidth: '80%',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
    boxShadow: bg === '#fff' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
  }
}

/** 通用按钮样式 */
export function btn(bg: string, color: string, border?: string): React.CSSProperties {
  return { padding: '6px 14px', borderRadius: 8, border: border ?? 'none', background: bg, color, fontSize: 13, cursor: 'pointer' }
}

/** 图标按钮（输入区功能行） */
export const iconBtn: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid #eee',
  background: '#fff',
  fontSize: 14,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#555',
}

/** 小图标按钮（侧边栏/顶栏） */
export const smallIconBtn: React.CSSProperties = {
  padding: 4,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#666',
}

/** 把字节数格式化成可读文本（B/KB/MB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 把 token 数格式化成可读文本（k/M） */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 把任意值转成可读字符串：对象/数组 JSON 序列化，避免 [object Object] */
export function prettyValue(v: unknown): string {
  if (v === null || v === undefined) return '（空）'
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…（共 ${v.length} 字）` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const s = JSON.stringify(v)
    return s.length > 300 ? `${s.slice(0, 300)}…` : s
  } catch {
    return String(v)
  }
}

/** 把工具参数渲染成友好键值对（长字符串截断，避免直接甩 JSON） */
export function formatArgs(args: Record<string, unknown> | undefined): React.ReactNode {
  if (!args || Object.keys(args).length === 0) return <span style={{ color: '#999' }}>（无参数）</span>
  const entries = Object.entries(args)
  return (
    <div>
      {entries.map(([k, v]) => (
        <div key={k} style={{ marginBottom: 2 }}>
          <span style={{ color: '#8c8c8c' }}>{k}：</span>
          <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' }}>{prettyValue(v)}</span>
        </div>
      ))}
    </div>
  )
}

/** 脱敏：把 token / api key / 密码等敏感字段替换为 ***，避免泄露 */
export function redactSecret(text: string): string {
  return text
    .replace(/((?:token|api[_-]?key|access_token|authorization|bearer|password|passwd|pwd|secret)\s*[:=]\s*)([^\s'"]+)/gi, '$1***')
    .replace(/(bearer\s+)([a-zA-Z0-9._-]+)/gi, '$1***')
}

/** 字符串截断（超出 max 显示「…（共 N 字）」） */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…（共 ${text.length} 字）`
}

/** 把工具结果转成可读字符串：字符串原样返回，对象/数组用 JSON 序列化 */
export function stringifyResult(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/** 读取本地文件为 data URL */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** 把文本写入剪贴板（navigator.clipboard 优先，失败回退 execCommand） */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

/** 思考中提示：三个依次跳动的点 */
export function ThinkingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, marginLeft: 4, verticalAlign: 'middle', alignItems: 'flex-end' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: '#999',
            display: 'inline-block',
            animation: `bounce 1.4s ${i * 0.18}s infinite ease-in-out`,
          }}
        />
      ))}
    </span>
  )
}
