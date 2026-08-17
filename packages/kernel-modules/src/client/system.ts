/**
 * 客户端模块系统：懒加载 CJS + 循环依赖保护（浏览器安全，零 node import）。
 *
 * - register 只注册工厂不物化
 * - require 递归物化，循环依赖返回部分导出（不无限递归）
 * - invalidate 失效重载
 */
export class ClientModuleSystem {
  private readonly factories = new Map<string, () => unknown>()
  private readonly cache = new Map<string, unknown>()
  private readonly loading = new Set<string>()

  register(id: string, factory: () => unknown): void {
    this.factories.set(id, factory)
  }

  require(id: string): unknown {
    if (this.cache.has(id)) return this.cache.get(id)
    if (this.loading.has(id)) {
      // 循环依赖：返回部分导出（undefined 占位），不无限递归
      return undefined
    }
    const factory = this.factories.get(id)
    if (!factory) throw new Error(`module "${id}" not registered`)
    this.loading.add(id)
    try {
      const exports = factory()
      this.cache.set(id, exports)
      return exports
    } finally {
      this.loading.delete(id)
    }
  }

  invalidate(id: string): void {
    this.cache.delete(id)
  }
}
