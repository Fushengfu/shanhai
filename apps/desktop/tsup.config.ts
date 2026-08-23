import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { 'main/index': 'src/main/index.ts' },
    format: ['esm'],
    // tesseract.js 动态 import（computer-use 跨平台 OCR 用），保持 external 让其从 node_modules 加载 wasm/worker 资源
    external: ['electron', 'node-pty', 'tesseract.js', 'tesseract.js-core'],
    // 把 @shanhai/* 打包进产物，避免 electron ESM 解析 workspace 软链接失败
    noExternal: [/@shanhai\//],
    clean: true,
    sourcemap: true,
  },
  {
    // preload 用 CommonJS（electron sandbox preload 不支持 ESM import）
    entry: { 'preload/index': 'src/preload/index.ts' },
    format: ['cjs'],
    external: ['electron'],
    clean: false,
    sourcemap: true,
    outExtension: () => ({ js: '.cjs' }),
  },
])
