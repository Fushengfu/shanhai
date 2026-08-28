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

// 声明 CommonJS 的 module（host 半契约：module.exports = (ctx) => disposer）。
// 注意必须用 var 而非 const：const 是块级声明，会与 @types/node 的全局 var module（module.d.ts）
// 冲突，报「Cannot redeclare block-scoped variable module」；var 可与其共存，插件项目 typecheck 才不报重复声明。
declare var module: { exports: unknown }

module.exports = (ctx: PluginContext): (() => void) => {
  // 1) 窗口应用默认「不自动开窗」：安装/加载后由用户主动打开（点 Dock 图标 → openApp → loadFile dist/client.html）。
  //    如需程序化开窗（例如收到某个事件时），在事件回调里显式调 ctx.openWindow()。
  // ctx.openWindow()  // ← 取消注释即可在 install/run 阶段立即开窗（不推荐：会打断用户当前工作）

  // 2) 订阅内核事件示例（撤销时自动取消订阅）
  ctx.on('demo-plugin:ping', (payload) => {
    console.log('[demo-plugin] 收到事件：', payload)
  })

  // 3) 注册命名服务（plugin_inspect 可查 services 列表）。
  //    若 impl 是函数，client 半可通过 window.shanhaiPlugin.invokePluginService('demo-plugin:getData', arg) 调用它（client → host RPC）。
  ctx.provide('demo-plugin:getData', async (query: unknown) => ({ echo: String(query ?? ''), at: Date.now() }))

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
