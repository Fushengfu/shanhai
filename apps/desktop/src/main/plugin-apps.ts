/**
 * 动态插件「窗口应用」注册表（多窗口桌面系统）。
 *
 * selfmod 插件（K5）的 client 半源码 = 一个「窗口内容组件源码」（契约：(React) => ReactComponent，返回窗口组件）。
 * 源码字符串天然可跨渲染进程传输：主进程在此维护「appId → { name, clientCode }」清单，
 * - 写入：runtime 广播 onClientCode 时由 push.ts 注册（install/restore 时触发 deliverClient → onClientCode）；
 * - 删除：runtime 广播 onClientRemove 时由 push.ts 注销（uninstall/stop 时触发 removeClient）；
 * - 查询：app 窗口渲染进程打开时经 IPC「plugin-app:get」拉取 clientCode，new Function 编译成组件渲染。
 *
 * 为什么放主进程：app 窗口是独立渲染进程，看不到聊天窗口（App.tsx）的 SlotRegistry；主进程是跨窗口共享点。
 */
export interface PluginAppManifest {
  appId: string
  name: string
  clientCode: string
}

const pluginApps = new Map<string, PluginAppManifest>()

/** 注册/更新一个动态插件的窗口应用（appId = 插件持久化 id，重名覆盖视为升级） */
export function registerPluginApp(appId: string, name: string, clientCode: string): void {
  if (!appId || !clientCode) return
  pluginApps.set(appId, { appId, name, clientCode })
}

/** 查询动态插件窗口应用（无则返回 undefined） */
export function getPluginApp(appId: string): PluginAppManifest | undefined {
  return pluginApps.get(appId)
}

/** 注销动态插件窗口应用 */
export function unregisterPluginApp(appId: string): void {
  pluginApps.delete(appId)
}

/** 列出所有动态插件窗口应用（供 Dock 图标等扩展用） */
export function listPluginApps(): PluginAppManifest[] {
  return [...pluginApps.values()]
}
