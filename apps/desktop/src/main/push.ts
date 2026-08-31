import { BrowserWindow } from 'electron'
import { safeSend } from './safe-send'
import { getRuntime } from './runtime'
import { getUiState, subscribeUiState, filterUiStateForWindow, windowConsumesUiState } from './ui-store'
import { getWindowType, openApp, closeApp } from './window-manager'
import { registerPluginApp, unregisterPluginApp, listPluginApps } from './plugin-apps'
import { refreshDockMenu } from './dock-menu'

/**
 * 主进程 → 渲染进程 事件推送（广播到所有窗口）。
 *
 * 多窗口桌面系统：聊天核心状态（会话消息流 / 流式 / 审批 / token / 轨迹等）已上移到主进程 ui-store，
 * 由 ui-store 监听 runtime 事件维护，此处只广播「ui:state」快照给所有窗口订阅。
 * 仅两类事件保留直接广播（不走 store）：用户手动终端输出（高频逐字节）、自修改 K5 动态包投递。
 */
export function registerPush(): void {
  const runtime = getRuntime()

  const broadcast = (channel: string, ...args: unknown[]): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win, channel, ...args)
    }
  }

  // 用户手动终端实时输出（会话级 + 终端级路由，高频逐字节，不经过 store）
  runtime.onUserTerminalOutput((sessionId, terminalId, data) => broadcast('user-terminal:output', sessionId, terminalId, data))
  // 流式正文/思考增量：高频小事件直发，不进 ui-store、不触发全量 ui:state 广播。
  // 否则每个 token 都会把「所有会话完整历史」整体序列化广播给所有窗口，长任务几千 token = 几千次全量广播，
  // 内存/IPC 被放大到极限（曾导致 swap 打满 + 内核 watchdog panic）。
  runtime.onDelta((sessionId, text) => broadcast('chat:delta', sessionId, text))
  runtime.onReasoning((sessionId, text) => broadcast('chat:reasoning', sessionId, text))
  // 自修改（K5）：browser 半投递的 round-trip 审批 + 代码投递 + 卸载（非 store 状态）
  runtime.onClientRunRequest((req) => broadcast('selfmod:client-run-request', req))
  // 投递确认被决策（用户手动点或管家 resolve_client_run）后广播「已解决」，UI 据此关闭对应弹窗（跨端同步）
  runtime.onClientRunResolved((requestId) => broadcast('selfmod:client-run-resolved', requestId))
  runtime.onClientCode((payload) => {
    // 动态插件窗口应用：把 client 半编译产物（entryHtml）+ 权限清单注册进主进程清单
    // （app 窗口 loadFile 渲染 + plugin:invoke 校验），再广播给聊天窗口 slots。
    // 纯编译产物插件（只有 entryHtml）也在此注册，使 Dock 图标 + isPluginApp + loadFile 生效。
    registerPluginApp(payload.pkgId, payload.name, payload.permissions ?? [], payload.entryHtml, payload.icon)
    broadcast('selfmod:client-code', payload)
    // 通知桌面壳 Dock 刷新动态插件应用图标
    broadcast('plugin-apps:changed', listPluginApps())
    // 刷新 macOS Dock 菜单（插件列表动态更新）
    refreshDockMenu()
  })
  runtime.onClientRemove((pkgId) => {
    unregisterPluginApp(pkgId)
    broadcast('selfmod:client-remove', pkgId)
    // 通知桌面壳 Dock 移除动态插件应用图标
    broadcast('plugin-apps:changed', listPluginApps())
    // 刷新 macOS Dock 菜单（插件列表动态更新）
    refreshDockMenu()
  })
  // 插件窗口应用：host 半 ctx.openWindow → runtime.openAppWindow → 主进程 openApp（复用 app 窗口类型）
  runtime.onOpenPluginApp((appId) => void openApp(appId))
  // 插件窗口应用关闭：host 半 ctx.closeWindow / 撤销时 → runtime.closeAppWindow → 主进程 closeApp（销毁对应窗口）
  runtime.onClosePluginApp((appId) => void closeApp(appId))

  // 全局 UI 共享状态变化 → 广播快照（按窗口类型过滤：dock/supervisor-bubble 不消费共享状态直接跳过；
  // desktop 只收登录态+壁纸精简快照；chat/supervisor/app 收完整快照。避免把含所有会话完整历史的重快照发给不消费的窗口）
  // —— 高频触发源（onToolTrace 每个工具步骤 / onTokenStats / onSessionActivity / onUserMessage / onCurrentSessionChanged
  //     等）每次 mutate 都同步触发本回调，而广播的是「含所有会话完整历史」的完整快照（safeSend=IPC structured-clone
  //     深序列化整棵树）。密集任务下（单次执行几十上百个工具步骤）会产生同量级的全量序列化 + IPC 往返，
  //     内存/GC 压力与 IPC 放大到极限（注释里已记录曾导致 swap 打满）。故这里合并到同一 16ms 窗口只广播一次最终快照，
  //     显著降频（从「每次工具步骤一次」→「每 16ms 一次」），审批/登录态等低频即时状态最多延迟 16ms，无感知。
  let uiStatePending = false
  const broadcastUiState = (): void => {
    if (uiStatePending) return
    uiStatePending = true
    const timer = setTimeout(() => {
      uiStatePending = false
      const full = getUiState()
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        const type = getWindowType(win)
        if (!windowConsumesUiState(type)) continue
        safeSend(win, 'ui:state', filterUiStateForWindow(type, full))
      }
    }, 16)
    timer.unref?.()
  }
  subscribeUiState(broadcastUiState)
}
