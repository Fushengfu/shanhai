import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 插件应用「进程内构建器」（升级方案第 6 步）。
 *
 * 目标：让终端 AI 从「编写 → 编译 → 测试 → 加载 → 验证 → 安装」全程不依赖用户手动 npm install / node。
 * - host 半：用 esbuild --bundle --platform=node --format=cjs 产出自包含 host.cjs（可 require 第三方依赖）。
 * - client 半：用 vite build 产出 client.html + dist/assets/*（完整 React bundle，自包含）。
 *
 * 构建器定位（关键）：esbuild / vite / react 是「山海桌面端进程内已有的依赖」，本文件不静态 import 它们，
 * 而是运行时用 createRequire / 动态 import 定位，避免被 tsup 打进 selfmod 产物（导致二进制/巨大 bundle）。
 * 打包分发后若这些构建器不在 app 依赖里（它们在 devDependencies），load* 会返回 null，
 * buildPlugin 会优雅降级并给出明确 warning——这是「现场编译」在终端环境的已知边界，由后续打包配置补齐。
 */

// 主进程 require 上下文（与 selfmod.ts 的 nodeRequire 同源；selfmod 被 desktop 以 noExternal bundle 成 ESM）
const nodeRequire = createRequire(import.meta.url)

/** 向上查找最近的 node_modules 目录（山海进程自己的依赖根，供 esbuild nodePaths / vite alias 解析 react 等） */
function findNodeModulesUp(fromDir: string): string | null {
  let dir = fromDir
  for (;;) {
    const nm = join(dir, 'node_modules')
    if (existsSync(nm)) return nm
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

type EsbuildModule = { build: (opts: Record<string, unknown>) => Promise<unknown>; buildSync: (opts: Record<string, unknown>) => unknown }

/** 定位 esbuild（CJS，可 require）：先直接 require，再从 vite / tsup 的依赖树回退定位 */
function loadEsbuild(): EsbuildModule | null {
  const candidates: Array<() => unknown> = [
    () => nodeRequire('esbuild'),
    () => createRequire(nodeRequire.resolve('vite/package.json'))('esbuild'),
    () => createRequire(nodeRequire.resolve('tsup/package.json'))('esbuild'),
  ]
  for (const load of candidates) {
    try {
      const mod = load() as EsbuildModule
      if (mod && typeof mod.build === 'function') return mod
    } catch {
      // 尝试下一条路径
    }
  }
  return null
}

/** 定位 vite（ESM-only，动态 import） */
async function loadVite(): Promise<{ build: (cfg: Record<string, unknown>) => Promise<unknown> } | null> {
  try {
    // @ts-expect-error vite 由桌面端运行时提供（desktop devDependencies），selfmod 不静态依赖它
    const mod = await import('vite')
    if (mod && typeof mod.build === 'function') return mod as { build: (cfg: Record<string, unknown>) => Promise<unknown> }
    return null
  } catch {
    return null
  }
}

/** 定位 @vitejs/plugin-react（ESM，动态 import；vite 构建 React client 半需要） */
async function loadReactPlugin(): Promise<((opts?: unknown) => unknown) | null> {
  try {
    // @ts-expect-error @vitejs/plugin-react 由桌面端运行时提供，selfmod 不静态依赖它
    const mod = await import('@vitejs/plugin-react')
    const plugin = (mod && (mod.default ?? mod)) as ((opts?: unknown) => unknown) | undefined
    return typeof plugin === 'function' ? plugin : null
  } catch {
    return null
  }
}

/** 校验插件 id（与 SelfModifyRuntime.persistIdOf 一致：仅 [a-zA-Z0-9_-]） */
function validateId(id: string): string {
  const raw = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!raw) throw new Error('插件 id 需含字母/数字/连字符（如 todo-list）')
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) throw new Error(`非法插件 id（仅允许字母/数字/下划线/连字符）: ${raw}`)
  return raw
}

export interface PluginBuildResult {
  id: string
  projectDir: string
  /** host 半编译产物绝对路径（dist/host.cjs），未构建则 null */
  hostEntry: string | null
  /** client 半窗口入口绝对路径（dist/client.html），未构建则 null */
  clientHtml: string | null
  /** client 半产物资源相对路径（dist/assets/*） */
  assets: string[]
  /** 构建过程中的非致命告警（如某个构建器不可用、跳过某个半） */
  warnings: string[]
}

/**
 * 编译插件应用项目到其 dist/ 目录：
 * - host 半（src/host.ts 存在时）→ esbuild 自包含 bundle 产出 dist/host.cjs；
 * - client 半（client.html + src/main.tsx 存在时）→ vite build 产出 dist/client.html + dist/assets/*。
 *
 * 顺序：先 vite（emptyOutDir 清空旧 dist），再 esbuild 写 host.cjs，避免 host.cjs 被 vite 清掉。
 */
export async function buildPlugin(projectDir: string, id: string): Promise<PluginBuildResult> {
  const pid = validateId(id)
  const warnings: string[] = []
  let hostEntry: string | null = null
  let clientHtml: string | null = null
  const assets: string[] = []

  const absDir = resolve(projectDir)
  const hasHost = existsSync(join(absDir, 'src', 'host.ts'))
  const hasClient = existsSync(join(absDir, 'client.html')) && existsSync(join(absDir, 'src', 'main.tsx'))

  if (!hasHost && !hasClient) {
    throw new Error(`插件项目缺少可编译入口（需 src/host.ts 或 client.html + src/main.tsx）: ${absDir}`)
  }

  // —— client 半：vite build（React bundle，自包含）——
  if (hasClient) {
    const vite = await loadVite()
    const reactPlugin = await loadReactPlugin()
    if (!vite || !reactPlugin) {
      warnings.push('进程内 vite / @vitejs/plugin-react 不可用，跳过 client 半构建（产物将无 client.html）')
    } else {
      // 依赖解析根：山海进程自己的 node_modules（让插件项目免 npm install 也能解析 react 等）
      const nm = findNodeModulesUp(dirname(fileURLToPath(import.meta.url)))
      let reactDir: string | undefined
      let reactDomDir: string | undefined
      if (nm) {
        try {
          reactDir = dirname(nodeRequire.resolve('react/package.json'))
          reactDomDir = dirname(nodeRequire.resolve('react-dom/package.json'))
        } catch {
          // react 不在山海 node_modules：跳过 alias（vite 会从插件项目自身解析，可能失败）
        }
      }
      const alias: Record<string, string> = {}
      if (reactDir) {
        alias['react'] = reactDir
        alias['react/jsx-runtime'] = join(reactDir, 'jsx-runtime.js')
        alias['react/jsx-dev-runtime'] = join(reactDir, 'jsx-dev-runtime.js')
      }
      if (reactDomDir) {
        alias['react-dom'] = reactDomDir
        alias['react-dom/client'] = join(reactDomDir, 'client.js')
      }
      await vite.build({
        root: absDir,
        base: './',
        configFile: false,
        logLevel: 'warn',
        plugins: [reactPlugin()],
        resolve: { alias },
        build: {
          outDir: resolve(absDir, 'dist'),
          emptyOutDir: true,
          rollupOptions: {
            input: resolve(absDir, 'client.html'),
          },
        },
      })
      const html = resolve(absDir, 'dist', 'client.html')
      if (existsSync(html)) clientHtml = html
      // 收集 assets 产物
      const assetsDir = resolve(absDir, 'dist', 'assets')
      try {
        for (const f of await fs.readdir(assetsDir)) {
          assets.push(`assets/${f}`)
        }
      } catch {
        // 无 assets 目录
      }
    }
  }

  // —— host 半：esbuild 自包含 bundle ——
  if (hasHost) {
    const esbuild = loadEsbuild()
    if (!esbuild) {
      warnings.push('进程内 esbuild 不可用，跳过 host 半构建（产物将无 host.cjs）')
    } else {
      const nm = findNodeModulesUp(dirname(fileURLToPath(import.meta.url)))
      await esbuild.build({
        entryPoints: [resolve(absDir, 'src', 'host.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: resolve(absDir, 'dist', 'host.cjs'),
        // 让 host.ts 里的第三方依赖从山海进程 node_modules 解析（免插件项目 npm install）
        nodePaths: nm ? [nm] : [],
        // 自包含：不 external 任何东西。electron / @shanhai/* 若被误 external，loadHostEntry 会拒绝加载。
        // logLevel 'error'：抑制 host.ts 用 module.exports 而 package.json 为 type:module 时 esbuild 的
        // commonjs-variable-in-esm 警告（无害，--format=cjs 仍强制输出 CJS），避免 build 输出噪音。
        logLevel: 'error',
      })
      const hostCjs = resolve(absDir, 'dist', 'host.cjs')
      if (existsSync(hostCjs)) hostEntry = hostCjs
    }
  }

  return { id: pid, projectDir: absDir, hostEntry, clientHtml, assets, warnings }
}

/** 供 plugin_verify 复用的「产物存在性 + 越权审计」检查（不依赖实际构建） */
export async function verifyBuildArtifacts(projectDir: string): Promise<{
  hostEntry: string | null
  clientHtml: string | null
  hostAudit: { ok: boolean; reason?: string } | null
}> {
  const absDir = resolve(projectDir)
  const hostEntry = resolve(absDir, 'dist', 'host.cjs')
  const clientHtml = resolve(absDir, 'dist', 'client.html')
  const hasHost = existsSync(hostEntry)
  const hasHtml = existsSync(clientHtml)

  let hostAudit: { ok: boolean; reason?: string } | null = null
  if (hasHost) {
    try {
      const src = await fs.readFile(hostEntry, 'utf8')
      if (/\brequire\s*\(\s*['"](electron|@shanhai[^'"]*)['"]\s*\)/.test(src)) {
        hostAudit = { ok: false, reason: 'host 半产物违规 external（electron / @shanhai/*），请以自包含 bundle 重新构建' }
      } else {
        hostAudit = { ok: true }
      }
    } catch (err) {
      hostAudit = { ok: false, reason: `读取 host 产物失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  return { hostEntry: hasHost ? hostEntry : null, clientHtml: hasHtml ? clientHtml : null, hostAudit }
}
