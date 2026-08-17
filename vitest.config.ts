import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@shanhai/runtime', replacement: resolve(root, 'apps/runtime/src') },
      { find: '@shanhai/desktop', replacement: resolve(root, 'apps/desktop/src') },
      { find: /^@shanhai\/(.+)$/, replacement: resolve(root, 'packages/$1/src') },
    ],
  },
  test: {
    testTimeout: 10000,
  },
})
