import type { Context } from '../runtime/context'
import type { Capability } from '../types'

/**
 * 能力清单强制（least privilege）。
 *
 * 为插件创建带能力约束的子上下文：插件只能 provide 声明的服务、
 * 只能 consume 声明的服务，越界即抛错（响亮失败，不静默跳过）。
 *
 * 能力清单 ≠ 授权：能力清单是静态声明，审批是运行时决策，两者独立。
 */
export function guardContext(ctx: Context, caps: Capability): Context {
  return ctx.guard(caps)
}
