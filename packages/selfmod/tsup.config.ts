import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // 进程内构建器（第 6 步）：build.ts 用动态 import / createRequire 在运行时定位 esbuild / vite / @vitejs/plugin-react，
  // 这里把它们标记为 external，避免 tsup 在打包 selfmod 时把它们（含 esbuild 平台二进制 / vite 全家桶）打进产物。
  // selfmod 被 desktop 以 noExternal 打进主进程产物后，这些 import 仍保留，运行时从桌面端 node_modules 解析。
  external: ['esbuild', 'vite', '@vitejs/plugin-react'],
})
