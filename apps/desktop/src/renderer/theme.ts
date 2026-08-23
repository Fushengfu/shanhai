import { useEffect } from 'react'

/** 主题模式（亮/暗），与 localStorage 的 shanhai-theme 键、theme.css 的 data-theme 属性对齐 */
export type ThemeMode = 'light' | 'dark'

/** 读取持久化主题（默认亮色） */
export function readTheme(): ThemeMode {
  try {
    return localStorage.getItem('shanhai-theme') === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 把主题应用到当前窗口根元素（驱动 theme.css 的 CSS 变量） */
export function applyTheme(theme: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', theme)
}

/**
 * 只读窗口（会话管家 / Dock / 桌面壳 / 应用窗口 / 管家悬浮图标）订阅主题：
 * 挂载时读取一次 localStorage，并订阅主进程 ui:theme 广播，实时跟随聊天窗口切换。
 * 聊天窗口（App）是主题的唯一写者，通过 window.shanhai.setTheme 广播，故它不走此 hook。
 */
export function useThemeSync(): void {
  useEffect(() => {
    applyTheme(readTheme())
    const off = window.shanhai?.onThemeChange((theme) => applyTheme(theme))
    return off
  }, [])
}
