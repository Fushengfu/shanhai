/**
 * 插件 host 半（主进程侧，工程化编译产物）。
 *
 * 契约：必须 module.exports = (ctx) => disposer（不能写成裸箭头函数）。
 * ctx 提供五条能力：on / provide / tools.register / openWindow / closeWindow。
 * disposer 可为函数 / null / 数组 / Promise（撤销时逆序调用）。
 *
 * 构建：esbuild src/host.ts --bundle --platform=node --format=cjs --outfile=dist/host.cjs
 * 产物必须是「自包含 bundle」：第三方依赖打进产物，且不能 external electron / @shanhai/*，
 * 否则主进程 loadHostEntry 会拒绝加载。require 第三方依赖的方式就是直接 import，esbuild 会打包进去。
 */

/** host 半拿到的 facade（ctx）类型声明 */
interface PluginContext {
  on(name: string, listener: (...args: unknown[]) => unknown): void
  provide(name: string, impl: unknown): void
  tools: { register(tool: unknown): void }
  openWindow(appId?: string): void
  closeWindow(appId?: string): void
}

// 声明 CommonJS 的 module（host 半契约：module.exports = (ctx) => disposer）
declare const module: { exports: unknown }

module.exports = (ctx: PluginContext): (() => void) => {
  // 1) 打开本插件的独立窗口（appId 缺省 = 插件 id）。
  //    注意：openWindow 在 install/run 阶段即开窗（不是等点 Dock 图标；点 Dock 是另一条 openApp 链路）。
  ctx.openWindow()

  // 2) 订阅内核事件示例（撤销时自动取消订阅）
  ctx.on('demo-plugin:ping', (payload) => {
    console.log('[demo-plugin] 收到事件：', payload)
  })

  // 3) 注册命名服务（plugin_inspect 可查 services 列表）
  ctx.provide('demo-plugin:service', { ping: () => 'pong' })

  // 4) 注册全局工具示例（撤销时自动注销）—— 需要时取消注释
  // ctx.tools.register({
  //   name: 'demo-plugin_echo',
  //   description: '回声工具示例',
  //   inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  //   execute: async (args) => ({ echo: String(args.text ?? '') }),
  // })

  // 5) 返回 disposer：插件卸载 / 停止时调用
  return () => {
    console.log('[demo-plugin] host 半已卸载')
  }
}
