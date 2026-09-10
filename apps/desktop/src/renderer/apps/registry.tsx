import type { ComponentType } from 'react'
import { IconActivity, IconClock, IconGrid, IconWrench } from '../components/icons'
// 【任务181】Dock 槽位改用专用图标族：原来「私信 / 聊天」同为 IconChat、「管家 / 退出到桌面」同为 IconMonitor，
// 同排里两个槽位一个字形，用户无法区分；且通用图标被标题栏等处复用，不能就地改。
import {
  IconDockChat,
  IconDockMarketplace,
  IconDockMessages,
  IconDockSupervisor,
  IconDockTerminal,
  IconDockSettings,
  IconDockModels,
  IconDockWallpaper,
} from '../components/icons'
import { t } from '../../shared/i18n'

/**
 * 插件应用清单（多窗口桌面系统的「应用」注册表）。
 * 桌面壳 Dock 据此渲染应用图标，点击 openApp(app.id) 打开对应独立窗口。
 * 每个应用承载一个独立 BrowserWindow（app 类型），Step 4 起逐个迁入真实面板。
 */
export interface AppManifest {
  /** 路由键：openApp(appId) / 窗口归属都靠它，**绝不进语言包、绝不翻译** */
  id: string
  /**
   * 【i18n 期4C】展示名一律存词条 key，渲染期再 t() 取。
   * 为什么不在这里就拼好中文：模块级常量在**加载期**求值，切语言不会重算 ——
   * 这个坑历轮已实证六次（STATUS_LABEL / TOOL_META / SUPERVISOR_ARG_LABELS /
   * PROTOCOL_OPTIONS / SECTIONS / ROLE_META），本期是第七次。
   * 展示请走 appNameOf() / appDescOf()，别直接读字段。
   */
  nameKey: string
  descKey: string
  Icon: ComponentType
  /**
   * 是否作为 Dock 上「直接可见」的应用图标显示。
   * 省略 = 显示；设为 false = 仍注册（openApp 照常可打开、窗口标题等不受影响），
   * 只是不占 Dock 图标位——这类应用改由二级入口进入（如聊天窗口顶栏按钮）。
   */
  showInDock?: boolean
}

export const APP_REGISTRY: AppManifest[] = [
  { id: 'marketplace', nameKey: 'app.marketplace.name', descKey: 'app.marketplace.desc', Icon: IconDockMarketplace },
  // 私信（会员实时通讯底线的内置 UI）：占 Dock 图标位，便于发现与看到未读红点
  { id: 'messages', nameKey: 'app.messages.name', descKey: 'app.messages.desc', Icon: IconDockMessages },
  { id: 'chat', nameKey: 'app.chat.name', descKey: 'app.chat.desc', Icon: IconDockChat },
  // 【任务221 · 第2条】会话管家不再占 Dock 图标位（用户明确要求「dock上的管家应用按钮也不需要了」）：
  // 单窗口化后管家界面就在主窗口右列（左列「会话管家」条目进入），Dock 再给一个图标只会让人以为还要开个窗口。
  // 保留注册（showInDock:false）而非删条目：注册表还承担 app 展示名解析等用途，且 openApp('supervisor')
  // 仍是一条安全的入口（window-manager 里它已转发到主窗口，不会再 new 出独立管家窗口）。
  { id: 'supervisor', nameKey: 'app.supervisor.name', descKey: 'app.supervisor.desc', Icon: IconDockSupervisor, showInDock: false },
  { id: 'terminal', nameKey: 'app.terminal.name', descKey: 'app.terminal.desc', Icon: IconDockTerminal },
  // 轨迹 / 记忆：不直接占 Dock 图标位，入口收敛到聊天窗口顶栏（HeaderPlugin 的「记忆」「轨迹」按钮）
  { id: 'trace', nameKey: 'app.trace.name', descKey: 'app.trace.desc', Icon: IconActivity, showInDock: false },
  { id: 'memory', nameKey: 'app.memory.name', descKey: 'app.memory.desc', Icon: IconClock, showInDock: false },
  // 技能市场：入口在账号悬停弹窗的「技能」区（点击「去技能市场」），同记忆/轨迹一样不占 Dock 图标位
  { id: 'skills-market', nameKey: 'app.skillsMarket.name', descKey: 'app.skillsMarket.desc', Icon: IconWrench, showInDock: false },
  // MCP 管理：入口在账号悬停弹窗的「MCP 服务」区（「MCP 管理」），编辑已有服务 / 启停，不占 Dock 图标位
  { id: 'mcp-manager', nameKey: 'app.mcpManager.name', descKey: 'app.mcpManager.desc', Icon: IconGrid, showInDock: false },
  { id: 'settings', nameKey: 'app.settings.name', descKey: 'app.settings.desc', Icon: IconDockSettings },
  { id: 'models', nameKey: 'app.models.name', descKey: 'app.models.desc', Icon: IconDockModels },
  { id: 'wallpaper', nameKey: 'app.wallpaper.name', descKey: 'app.wallpaper.desc', Icon: IconDockWallpaper },
]

/** Dock 直接显示的应用（过滤掉 showInDock === false 的二级入口应用） */
export const DOCK_APPS: AppManifest[] = APP_REGISTRY.filter((a) => a.showInDock !== false)

export function getAppManifest(appId: string): AppManifest | undefined {
  return APP_REGISTRY.find((a) => a.id === appId)
}

/** 应用展示名（**渲染期**调用；key 缺失时 t() 会兜底，界面不会露出 app.xxx） */
export function appNameOf(app: Pick<AppManifest, 'nameKey'>): string {
  return t(app.nameKey)
}

/** 应用描述（同上） */
export function appDescOf(app: Pick<AppManifest, 'descKey'>): string {
  return t(app.descKey)
}
