import { useEffect, useState } from 'react'
import { IconCode } from './icons'

/**
 * 插件应用图标（仅图标元素，不含名称/按钮外壳，便于 Dock 图标栏与主窗口应用区复用）。
 *
 * 图标优先读插件 manifest.icon（相对路径），经主进程 `plugin-app:icon` 读文件转 data URL；
 * 无 icon / 文件缺失 / 读取失败 → 降级为占位图标 IconCode。
 * 渲染进程 contextIsolation 无法直接读本地文件，故统一走主进程读文件转 base64。
 */
export function PluginAppIcon({ appId, size = 28 }: { appId: string; size?: number }): React.JSX.Element {
  const [iconUrl, setIconUrl] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void window.shanhai?.getPluginIcon(appId).then((url) => {
      if (mounted && url) setIconUrl(url)
    })
    return () => {
      mounted = false
    }
  }, [appId])

  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        style={{
          borderRadius: 7,
          objectFit: 'contain',
          display: 'block',
          flexShrink: 0,
          // SVG/PNG 图标按原始比例完整显示，避免 cover 裁剪掉图标边缘导致“看不清”
        }}
      />
    )
  }
  // 占位：与 Dock 现有插件图标风格一致（代码图标）
  return (
    <span
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <span style={{ transform: 'scale(1.4)', display: 'inline-flex' }}>
        <IconCode />
      </span>
    </span>
  )
}
