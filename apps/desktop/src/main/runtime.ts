import type { Runtime } from '@shanhai/runtime'

/**
 * 运行时句柄持有器。
 * 主进程入口（index.ts）在 boot 完成后 setRuntime，事件推送（push.ts）与
 * IPC 处理器（ipc-handlers.ts）通过 getRuntime 获取，避免把 runtime 塞进每个函数参数。
 */
let runtime: Runtime | null = null

export function setRuntime(r: Runtime): void {
  runtime = r
}

export function getRuntime(): Runtime {
  if (!runtime) throw new Error('运行时未初始化（应先 bootHost 再注册 IPC/推送）')
  return runtime
}
