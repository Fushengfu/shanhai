import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, extname, sep } from 'node:path'
import { homedir } from 'node:os'

/** 插件落盘目录根（与 @shanhai/runtime bootstrap.ts 的 PluginStore dir 一致：~/.shanhai/plugins） */
export const PLUGINS_DIR = join(homedir(), '.shanhai', 'plugins')

/**
 * 动态插件「窗口应用」注册表（多窗口桌面系统）。
 *
 * selfmod 插件（K5）统一走工程化独立应用：编译产物 dist/client.html 由主进程 loadFile 加载为独立窗口。
 * 主进程在此维护「appId → { name, permissions, entryHtml, icon }」清单，
 * - 写入：runtime 广播 onClientCode 时由 push.ts 注册（install/restore 时触发 deliverClient → onClientCode）；
 * - 删除：runtime 广播 onClientRemove 时由 push.ts 注销（uninstall/stop 时触发 removeClient）；
 * - 查询：app 窗口渲染进程打开时经 IPC「plugin-app:get」拉取元信息，openApp 用 entryHtml 做 loadFile 加载。
 *
 * 为什么放主进程：app 窗口是独立渲染进程；主进程是跨窗口共享点。
 *
 * permissions：插件在 install 时声明的白名单能力名清单，随 onClientCode 注册到本表，
 * 供 plugin:invoke 主进程入口做「插件 id + 能力名」双层校验——插件窗口调 window.shanhaiPlugin 时，
 * 只有出现在其 permissions 里的能力才会放行。
 */
export interface PluginAppManifest {
  appId: string
  name: string
  /** 插件声明的白名单能力名（plugin:invoke 校验用；缺省 = 空数组 = 最小权限） */
  permissions: string[]
  /** client 半编译产物绝对路径（dist/client.html，openApp 时靠它 loadFile 渲染） */
  entryHtml?: string
  /** 图标相对路径（相对插件目录，如 icon.png / assets/icon.png；第 4 步起，供 Dock 图标渲染） */
  icon?: string
}

const pluginApps = new Map<string, PluginAppManifest>()

/** 注册/更新一个动态插件的窗口应用（appId = 插件持久化 id，重名覆盖视为升级）。
 * 仅编译产物插件（entryHtml = dist/client.html）可注册。 */
export function registerPluginApp(appId: string, name: string, permissions: string[] = [], entryHtml?: string, icon?: string): void {
  if (!appId) return
  if (!entryHtml) return
  pluginApps.set(appId, { appId, name, permissions, entryHtml, icon })
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
 * 窗口据此走 loadFile 独立渲染入口（完整 React + JSX + 任意依赖 + 复杂 UI）。
 *
 * 防御：appId 仅允许 [a-zA-Z0-9_-]，杜绝路径穿越（appId 来自插件持久化 id，PluginStore 已校验，此处兜底）。
 */
export function resolvePluginEntryHtml(appId: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) return undefined
  const html = join(PLUGINS_DIR, appId, 'dist', 'client.html')
  return existsSync(html) ? html : undefined
}

/** icon 文件扩展名 → data URL 的 mime（未知扩展名不渲染，返回 undefined 走占位图标） */
const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/**
 * 把插件 manifest.icon（相对路径，如 icon.png / assets/icon.png）解析成 data URL，
 * 供渲染进程 <img> 直接显示（渲染进程 contextIsolation 无法直接读本地文件，走主进程读文件转 base64）。
 *
 * 防御：
 * - appId 仅允许 [a-zA-Z0-9_-]；
 * - 相对路径反斜杠归一化为 /，拒绝含 `..`、拒绝 `/` 开头（杜绝路径穿越）；
 * - join 后强制校验结果仍在插件目录内（双保险）；
 * - 文件不存在 / 读取失败 / mime 未知 → 返回 undefined（调用方降级占位图标）。
 */
export async function resolvePluginIconDataUrl(appId: string): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) return undefined
  const manifest = pluginApps.get(appId)
  if (!manifest?.icon) return undefined
  const rel = manifest.icon.replace(/\\/g, '/')
  if (rel.includes('..') || rel.startsWith('/')) return undefined
  const baseDir = join(PLUGINS_DIR, appId)
  const abs = join(baseDir, rel)
  if (!abs.startsWith(baseDir + sep)) return undefined
  const mime = ICON_MIME[extname(abs).toLowerCase()]
  if (!mime) return undefined
  if (!existsSync(abs)) return undefined
  try {
    const buf = await readFile(abs)
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}
