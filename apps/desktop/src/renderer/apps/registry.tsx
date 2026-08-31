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
}

export const APP_REGISTRY: AppManifest[] = [
  { id: 'marketplace', name: '创意空间', description: '浏览与安装插件', Icon: IconStore },
  { id: 'chat', name: '聊天', description: '聊天窗口', Icon: IconChat },
  { id: 'supervisor', name: '管家', description: '会话管家', Icon: IconMonitor },
  { id: 'terminal', name: '终端', description: '命令终端', Icon: IconTerminal },
  { id: 'trace', name: '轨迹', description: '执行轨迹', Icon: IconActivity },
  { id: 'memory', name: '记忆', description: '长期记忆', Icon: IconClock },
  { id: 'settings', name: '设置', description: '系统设置', Icon: IconSettings },
  { id: 'models', name: '模型', description: '模型管理', Icon: IconWrench },
  { id: 'wallpaper', name: '壁纸', description: '桌面背景', Icon: IconImage },
]

export function getAppManifest(appId: string): AppManifest | undefined {
  return APP_REGISTRY.find((a) => a.id === appId)
}
