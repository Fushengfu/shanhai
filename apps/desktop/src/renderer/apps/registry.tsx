import type { ComponentType } from 'react'
import { IconChat, IconMonitor, IconTerminal, IconActivity, IconClock, IconSettings, IconWrench, IconImage, IconStore } from '../components/icons'

/**
 * 插件应用清单（多窗口桌面系统的「应用」注册表）。
 * 桌面壳 Dock 据此渲染应用图标，点击 openApp(app.id) 打开对应独立窗口。
 * 每个应用承载一个独立 BrowserWindow（app 类型），Step 4 起逐个迁入真实面板。
 */
export interface AppManifest {
  id: string
  name: string
  description: string
  Icon: ComponentType
  /**
   * 是否作为 Dock 上「直接可见」的应用图标显示。
   * 省略 = 显示；设为 false = 仍注册（openApp 照常可打开、窗口标题等不受影响），
   * 只是不占 Dock 图标位——这类应用改由二级入口进入（如聊天窗口顶栏按钮）。
   */
  showInDock?: boolean
}

export const APP_REGISTRY: AppManifest[] = [
  { id: 'marketplace', name: '创意空间', description: '浏览与安装插件', Icon: IconStore },
  { id: 'chat', name: '聊天', description: '聊天窗口', Icon: IconChat },
  { id: 'supervisor', name: '管家', description: '会话管家', Icon: IconMonitor },
  { id: 'terminal', name: '终端', description: '命令终端', Icon: IconTerminal },
  // 轨迹 / 记忆：不直接占 Dock 图标位，入口收敛到聊天窗口顶栏（HeaderPlugin 的「记忆」「轨迹」按钮）
  { id: 'trace', name: '轨迹', description: '执行轨迹', Icon: IconActivity, showInDock: false },
  { id: 'memory', name: '记忆', description: '长期记忆', Icon: IconClock, showInDock: false },
  { id: 'settings', name: '设置', description: '系统设置', Icon: IconSettings },
  { id: 'models', name: '模型', description: '模型管理', Icon: IconWrench },
  { id: 'wallpaper', name: '壁纸', description: '桌面背景', Icon: IconImage },
]

/** Dock 直接显示的应用（过滤掉 showInDock === false 的二级入口应用） */
export const DOCK_APPS: AppManifest[] = APP_REGISTRY.filter((a) => a.showInDock !== false)

export function getAppManifest(appId: string): AppManifest | undefined {
  return APP_REGISTRY.find((a) => a.id === appId)
}
