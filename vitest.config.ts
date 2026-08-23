import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@shanhai/runtime', replacement: resolve(root, 'apps/runtime/src') },
      { find: '@shanhai/desktop', replacement: resolve(root, 'apps/desktop/src') },
      // 子路径导出（/client）需在正则兜底前精确匹配，否则会被映射成 packages/<pkg>/client/src
      { find: '@shanhai/kernel-modules/client', replacement: resolve(root, 'packages/kernel-modules/src/client') },
      { find: /^@shanhai\/(.+)$/, replacement: resolve(root, 'packages/$1/src') },
    ],
  },
  test: {
    testTimeout: 10000,
    // E2E 测试共享 ~/.shanhai/config.json 与真实网关，串行执行避免状态竞争 / 网关并发限流 500
    fileParallelism: false,
  },
})
