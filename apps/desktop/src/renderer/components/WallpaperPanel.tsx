import { useEffect, useRef, useState } from 'react'
import { useUiStore } from '../store-client'
import { IconImage } from './icons'
import { WindowTitleBar } from './WindowTitleBar'
import type { SystemWallpaperMeta } from '../types'

/** 预设壁纸（CSS backgroundImage 值；css 为 null 表示恢复默认渐变） */
const PRESETS: Array<{ id: string; name: string; css: string | null }> = [
  { id: 'default', name: '默认', css: null },
  { id: 'ocean', name: '深海', css: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { id: 'sunset', name: '日落', css: 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 50%, #a18cd1 100%)' },
  { id: 'forest', name: '森林', css: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' },
  { id: 'violet', name: '紫罗兰', css: 'linear-gradient(135deg, #4e54c8 0%, #8f94fb 100%)' },
  { id: 'aurora', name: '极光', css: 'linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%)' },
  { id: 'midnight', name: '午夜', css: 'linear-gradient(135deg, #232526 0%, #414345 100%)' },
  { id: 'rose', name: '玫瑰', css: 'linear-gradient(135deg, #ee9ca7 0%, #ffdde1 100%)' },
  // —— 科技深色系（多层光晕，高对比、未来感）——
  { id: 'deepspace', name: '深空', css: 'radial-gradient(1200px circle at 18% 22%, rgba(56,132,255,0.32) 0%, transparent 52%), radial-gradient(1000px circle at 82% 82%, rgba(124,58,237,0.30) 0%, transparent 55%), linear-gradient(160deg, #0b1120 0%, #121c36 48%, #0a0f1c 100%)' },
  { id: 'cyber', name: '赛博霓虹', css: 'radial-gradient(900px circle at 22% 16%, rgba(255,45,149,0.32) 0%, transparent 50%), radial-gradient(900px circle at 78% 84%, rgba(0,240,255,0.30) 0%, transparent 50%), linear-gradient(150deg, #0d0620 0%, #1b0f3a 52%, #090318 100%)' },
  { id: 'nebula', name: '星云', css: 'radial-gradient(1100px circle at 76% 18%, rgba(180,80,255,0.30) 0%, transparent 55%), radial-gradient(900px circle at 20% 80%, rgba(64,120,255,0.26) 0%, transparent 55%), linear-gradient(150deg, #140a2e 0%, #221255 50%, #0d0a20 100%)' },
  { id: 'cyan-glow', name: '荧光青', css: 'radial-gradient(1000px circle at 24% 18%, rgba(0,224,190,0.28) 0%, transparent 50%), radial-gradient(1000px circle at 78% 76%, rgba(64,150,255,0.24) 0%, transparent 50%), linear-gradient(160deg, #04181a 0%, #0a2b2e 50%, #051214 100%)' },
  { id: 'violet-electric', name: '紫电', css: 'radial-gradient(1000px circle at 25% 20%, rgba(147,51,234,0.35) 0%, transparent 50%), radial-gradient(900px circle at 78% 78%, rgba(59,130,246,0.28) 0%, transparent 50%), linear-gradient(160deg, #120b28 0%, #1d1240 50%, #0d0920 100%)' },
  { id: 'ember', name: '熔岩余烬', css: 'radial-gradient(1000px circle at 76% 18%, rgba(255,126,58,0.34) 0%, transparent 50%), radial-gradient(900px circle at 20% 80%, rgba(255,66,92,0.28) 0%, transparent 50%), linear-gradient(160deg, #1c0d08 0%, #2b130a 50%, #130905 100%)' },
  { id: 'emerald', name: '翡翠', css: 'radial-gradient(1000px circle at 20% 18%, rgba(0,204,142,0.30) 0%, transparent 50%), radial-gradient(900px circle at 80% 80%, rgba(0,164,204,0.24) 0%, transparent 50%), linear-gradient(160deg, #03140f 0%, #082b20 50%, #021009 100%)' },
  { id: 'graphite', name: '石墨黑', css: 'radial-gradient(1000px circle at 70% 18%, rgba(255,255,255,0.09) 0%, transparent 50%), linear-gradient(160deg, #1a1d21 0%, #25292e 50%, #121417 100%)' },
  { id: 'amber', name: '琥珀金', css: 'radial-gradient(1000px circle at 26% 20%, rgba(255,186,92,0.36) 0%, transparent 50%), radial-gradient(900px circle at 80% 80%, rgba(255,92,56,0.24) 0%, transparent 50%), linear-gradient(160deg, #1a1006 0%, #2c1d0c 50%, #140c04 100%)' },
  // —— 高端浅色系（简约、留白、质感）——
  { id: 'slate', name: '银灰', css: 'radial-gradient(1000px circle at 30% 22%, rgba(255,255,255,0.28) 0%, transparent 52%), linear-gradient(160deg, #c2cad6 0%, #96a1b0 50%, #6d7888 100%)' },
  { id: 'glacier', name: '冰川', css: 'radial-gradient(1000px circle at 20% 20%, rgba(160,214,255,0.55) 0%, transparent 55%), radial-gradient(1000px circle at 80% 85%, rgba(186,170,255,0.42) 0%, transparent 55%), linear-gradient(160deg, #eaf2fb 0%, #d9e7f6 50%, #c5d7ea 100%)' },
  { id: 'mist', name: '晨雾', css: 'radial-gradient(1000px circle at 30% 25%, rgba(255,255,255,0.50) 0%, transparent 55%), linear-gradient(160deg, #f2f4f7 0%, #e3e8ee 50%, #d2d9e2 100%)' },
]

/**
 * 壁纸应用（独立窗口）：切换桌面壳壁纸。
 * - 预设渐变：点击即应用（setWallpaper 写主进程 store + 持久化，desktop 窗口订阅后即时生效）
 * - 本地图片：选择图片文件 → base64 data URL 作为 backgroundImage（图片较大时以 data URL 内联存储）
 * - 恢复默认：选择「默认」预设（wallpaper = null）
 */
export function WallpaperPanel({ variant, onClose }: { variant: 'window'; onClose?: () => void }): React.JSX.Element {
  const ui = useUiStore()
  const fileRef = useRef<HTMLInputElement>(null)

  const apply = (css: string | null): void => {
    void window.shanhai?.setWallpaper(css)
  }

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      void window.shanhai?.setWallpaper(`url(${dataUrl})`)
    }
    reader.readAsDataURL(file)
    // 允许重复选择同一文件
    e.target.value = ''
  }

  const currentIsCustom = ui.wallpaper != null && !PRESETS.some((p) => p.css === ui.wallpaper)

  const [systemWallpapers, setSystemWallpapers] = useState<SystemWallpaperMeta[]>([])
  const [loadingSystem, setLoadingSystem] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoadingSystem(true)
    void window.shanhai
      ?.listSystemWallpapers()
      .then((list) => {
        if (!cancelled) setSystemWallpapers(list ?? [])
      })
      .catch(() => {
        if (!cancelled) setSystemWallpapers([])
      })
      .finally(() => {
        if (!cancelled) setLoadingSystem(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const applySystem = (sourcePath: string): void => {
    void window.shanhai?.applySystemWallpaper(sourcePath)
  }

  return (
    <div
      style={{
        ...(variant === 'window'
          ? { height: '100vh' }
          : { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 }),
        background: 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <WindowTitleBar
        icon={<IconImage />}
        title="壁纸"
        subtitle="选择桌面背景，即时生效"
        tone="purple"
        onClose={() => onClose?.()}
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            margin: '2px 0 12px',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            borderLeft: '3px solid var(--accent)',
            paddingLeft: 8,
          }}
        >
          预设壁纸
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
          {PRESETS.map((p) => {
            const active = ui.wallpaper === p.css
            return (
              <button
                key={p.id}
                onClick={() => apply(p.css)}
                title={p.name}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  padding: 8,
                  borderRadius: 12,
                  border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: 'var(--bg-sidebar)',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: 64,
                    borderRadius: 8,
                    background: p.css ?? 'var(--bg-app)',
                    ...(p.css ? { backgroundImage: p.css } : {}),
                    border: '1px solid var(--border-soft)',
                  }}
                />
                <span style={{ fontSize: 12, color: active ? 'var(--accent)' : 'var(--text)', fontWeight: active ? 600 : 400 }}>
                  {p.name}
                </span>
              </button>
            )
          })}
        </div>

        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            margin: '24px 0 12px',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            borderLeft: '3px solid var(--accent)',
            paddingLeft: 8,
          }}
        >
          系统壁纸
        </div>
        {loadingSystem ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>正在读取系统壁纸…</div>
        ) : systemWallpapers.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>未检测到系统壁纸</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
            {systemWallpapers.map((w) => (
              <button
                key={w.id}
                onClick={() => applySystem(w.id)}
                title={w.name}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  padding: 8,
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-sidebar)',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: 64,
                    borderRadius: 8,
                    backgroundImage: `url(${w.thumbnail})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    border: '1px solid var(--border-soft)',
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--text)' }}>{w.name}</span>
              </button>
            ))}
          </div>
        )}

        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            margin: '24px 0 12px',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            borderLeft: '3px solid var(--accent)',
            paddingLeft: 8,
          }}
        >
          本地图片
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px',
            borderRadius: 10,
            border: '1px solid var(--border)',
            background: 'var(--bg-sidebar)',
            color: 'var(--text)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          <IconImage />
          选择图片文件…
        </button>
        {currentIsCustom && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            当前使用自定义图片，选择预设或「默认」可恢复渐变。
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
      </div>
    </div>
  )
}
