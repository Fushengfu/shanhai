import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * 插件应用模板的独立构建配置。
 *
 * 与 desktop 主 vite.config.ts 分开：插件是独立渲染产物，构建后得到
 * dist/client.html + dist/assets/*（含完整 React bundle，自包含）。
 * 插件作者构建后把 dist/ 内容放到 ~/.shanhai/plugins/<id>/dist/ 下，
 * 主进程 openApp 检测到 dist/client.html 即用 loadFile 加载它。
 *
 * base './'：Electron loadFile(file://) 下资源必须相对路径，否则 assets 找不到。
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  root: __dirname,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'client.html'),
    },
  },
})
