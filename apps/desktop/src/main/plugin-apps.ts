import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 插件落盘目录根（与 @shanhai/runtime bootstrap.ts 的 PluginStore dir 一致：~/.shanhai/plugins） */
export const PLUGINS_DIR = join(homedir(), '.shanhai', 'plugins')

/**
 * 动态插件「窗口应用」注册表（多窗口桌面系统）。
 *
 * selfmod 插件（K5）的 client 半源码 = 一个「窗口内容组件源码」（契约：(React) => ReactComponent，返回窗口组件）。
 * 源码字符串天然可跨渲染进程传输：主进程在此维护「appId → { name, clientCode, permissions }」清单，
 * - 写入：runtime 广播 onClientCode 时由 push.ts 注册（install/restore 时触发 deliverClient → onClientCode）；
 * - 删除：runtime 广播 onClientRemove 时由 push.ts 注销（uninstall/stop 时触发 removeClient）；
 * - 查询：app 窗口渲染进程打开时经 IPC「plugin-app:get」拉取 clientCode，new Function 编译成组件渲染。
 *
 * 为什么放主进程：app 窗口是独立渲染进程，看不到聊天窗口（App.tsx）的 SlotRegistry；主进程是跨窗口共享点。
 *
 * permissions（第 1 步新增）：插件在 install 时声明的白名单能力名清单，随 onClientCode 注册到本表，
 * 供 plugin:invoke 主进程入口做「插件 id + 能力名」双层校验——插件窗口调 window.shanhaiPlugin 时，
 * 只有出现在其 permissions 里的能力才会放行。
 */
export interface PluginAppManifest {
  appId: string
  name: string
  clientCode: string
  /** 插件声明的白名单能力名（plugin:invoke 校验用；缺省 = 空数组 = 最小权限） */
  permissions: string[]
  /** client 半编译产物绝对路径（dist/client.html，第 2 步起；纯编译产物插件无 clientCode 时靠它 loadFile 渲染） */
  entryHtml?: string
  /** 图标相对路径（相对插件目录，如 icon.png / assets/icon.png；第 4 步起，供 Dock 图标渲染） */
  icon?: string
}

const pluginApps = new Map<string, PluginAppManifest>()

/** 注册/更新一个动态插件的窗口应用（appId = 插件持久化 id，重名覆盖视为升级）。
 * clientCode 可空（纯编译产物插件只有 entryHtml）；二者至少其一非空才注册。 */
export function registerPluginApp(appId: string, name: string, clientCode: string, permissions: string[] = [], entryHtml?: string, icon?: string): void {
  if (!appId) return
  if (!clientCode && !entryHtml) return
  pluginApps.set(appId, { appId, name, clientCode, permissions, entryHtml, icon })
}

/** 查询动态插件窗口应用（无则返回 undefined） */
export function getPluginApp(appId: string): PluginAppManifest | undefined {
  return pluginApps.get(appId)
}

/** 判断 appId 是否为「动态插件窗口应用」（区别于内置 app：terminal/trace/memory/settings/models/wallpaper 等） */
export function isPluginApp(appId: string): boolean {
  return pluginApps.has(appId)
}

/** 注销动态插件窗口应用 */
export function unregisterPluginApp(appId: string): void {
  pluginApps.delete(appId)
}

/** 列出所有动态插件窗口应用（供 Dock 图标等扩展用） */
export function listPluginApps(): PluginAppManifest[] {
  return [...pluginApps.values()]
}

/**
 * 解析插件窗口的独立渲染入口（编译产物 dist/client.html，第 2 步起支持）。
 *
 * 插件作者把编译产物放到 ~/.shanhai/plugins/<id>/dist/client.html（+ 相邻 assets），
 * 窗口据此走 loadFile 独立渲染入口（完整 React + JSX + 任意依赖 + 复杂 UI）；
 * 无编译产物（快速原型链路）则返回 undefined，窗口降级走 renderer/index.html →
 * AppWindow → DynamicPluginWindow 的 new Function 源码字符串渲染。
 *
 * 防御：appId 仅允许 [a-zA-Z0-9_-]，杜绝路径穿越（appId 来自插件持久化 id，PluginStore 已校验，此处兜底）。
 */
export function resolvePluginEntryHtml(appId: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) return undefined
  const html = join(PLUGINS_DIR, appId, 'dist', 'client.html')
  return existsSync(html) ? html : undefined
}
