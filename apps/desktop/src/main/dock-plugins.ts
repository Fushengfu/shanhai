import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { safeSend } from './safe-send'
import { getPluginApp, isPluginApp, type PluginAppManifest } from './plugin-apps'

/**
 * Dock 手动固定的插件应用清单（多窗口桌面系统）。
 *
 * 与「已安装插件应用清单」（plugin-apps.ts）解耦：安装插件后【不】自动显示到 Dock，
 * 而是由用户手动从桌面壳（PluginAppsPanel）拖拽图标到 Dock 添加。本模块负责三件事：
 * 1. 持久化 Dock 固定清单（userData/dock-plugins.json，跨重启留存）；
 * 2. 跨窗口拖拽状态（desktop 发起 → dock 接收，经主进程中转广播）；
 * 3. 广播清单/拖拽状态变化给所有窗口。
 */

/** 持久化文件路径（userData/dock-plugins.json，独立于插件落盘目录 ~/.shanhai/plugins） */
function dockPluginsPath(): string {
  return join(app.getPath('userData'), 'dock-plugins.json')
}

/** 读取持久化的 Dock 固定插件 id 清单（过滤掉已卸载的，避免残留无效图标） */
function readDockPluginIds(): string[] {
  try {
    const raw = readFileSync(dockPluginsPath(), 'utf8')
    const parsed = JSON.parse(raw) as { ids?: unknown }
    if (Array.isArray(parsed.ids)) {
      return parsed.ids.filter((x): x is string => typeof x === 'string' && isPluginApp(x))
    }
    return []
  } catch {
    return []
  }
}

/** 持久化 Dock 固定插件 id 清单（失败只告警，不中断） */
function persistDockPluginIds(ids: string[]): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(dockPluginsPath(), JSON.stringify({ ids }), 'utf8')
  } catch (err) {
    console.warn('[山海] 保存 Dock 插件清单失败：', err)
  }
}

/** 列出 Dock 上应显示的插件应用（手动固定的，且仍已安装） */
export function listDockPluginApps(): PluginAppManifest[] {
  return readDockPluginIds()
    .map((id) => getPluginApp(id))
    .filter((x): x is PluginAppManifest => !!x)
}

/** 添加一个插件到 Dock（已存在则忽略），返回最新清单 */
export function addDockPlugin(appId: string): PluginAppManifest[] {
  if (!isPluginApp(appId)) return listDockPluginApps()
  const ids = readDockPluginIds()
  if (!ids.includes(appId)) {
    ids.push(appId)
    persistDockPluginIds(ids)
  }
  return listDockPluginApps()
}

/** 从 Dock 移除一个插件，返回最新清单 */
export function removeDockPlugin(appId: string): PluginAppManifest[] {
  const ids = readDockPluginIds().filter((x) => x !== appId)
  persistDockPluginIds(ids)
  return listDockPluginApps()
}

/** 当前进行中的跨窗口插件拖拽（appId；无拖拽时为 null） */
let activeDragAppId: string | null = null

/** 广播给所有存活窗口 */
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win, channel, ...args)
  }
}

/** 广播最新 Dock 固定插件清单（Dock 窗口据此刷新图标） */
function broadcastDockList(): void {
  broadcast('dock-plugins:changed', listDockPluginApps())
}

/** 开始一次「从桌面拖插件到 Dock」：记录 appId + 通知 Dock 进入可接受状态 */
export function beginPluginDrag(appId: string): void {
  if (!isPluginApp(appId)) return
  activeDragAppId = appId
  broadcast('dock-plugin-drag:start', appId)
}

/** 结束拖拽（无论成功/取消），通知 Dock 退出可接受状态 */
function endDrag(): void {
  activeDragAppId = null
  broadcast('dock-plugin-drag:end')
}

/** 取消拖拽（用户在非 Dock 区域释放） */
export function cancelPluginDrag(): void {
  if (activeDragAppId == null) return
  endDrag()
}

/** 完成拖拽（用户在 Dock 上释放）：把 appId 加入 Dock 并广播最新清单 */
export function completePluginDrag(): PluginAppManifest[] {
  const appId = activeDragAppId
  endDrag()
  if (!appId) return listDockPluginApps()
  const list = addDockPlugin(appId)
  broadcastDockList()
  return list
}
