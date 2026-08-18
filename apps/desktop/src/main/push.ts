import type { BrowserWindow } from 'electron'
import { getRuntime } from './runtime'

/**
 * 主进程 → 渲染进程 事件推送。
 * 流式增量 / 工具过程 / 审批请求 / token 用量，均带 sessionId 路由，供渲染进程按会话隔离。
 */
export function registerPush(win: BrowserWindow): void {
  const runtime = getRuntime()
  const send = (channel: string, ...args: unknown[]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  runtime.onDelta((sessionId, text) => send('chat:delta', sessionId, text))
  runtime.onReasoning((sessionId, text) => send('chat:reasoning', sessionId, text))
  runtime.onToolTrace((trace) => send('tool:trace', trace))
  runtime.onApprovalRequest((req) => send('approval:request', req))
  runtime.onTokenStats((sessionId, stats) => send('token:stats', sessionId, stats))
  // 自修改（K5）：browser 半投递的 round-trip 审批 + 代码投递 + 卸载
  runtime.onClientRunRequest((req) => send('selfmod:client-run-request', req))
  runtime.onClientCode((payload) => send('selfmod:client-code', payload))
  runtime.onClientRemove((pkgId) => send('selfmod:client-remove', pkgId))
  // 多专家编排轨迹
  runtime.onExpertTrace((trace) => send('expert:trace', trace))
}
