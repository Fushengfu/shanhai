/**
 * host 半「危险 node 内置模块」审计（阶段0 安全补漏）。
 *
 * 背景（代码事实，勿臆断）：
 * - host 半是 esbuild `--bundle --platform=node --format=cjs` 产物（build.ts:224-234），
 *   用主进程 nodeRequire 加载（selfmod.ts `loadHostEntry`）。
 * - esbuild `platform:node` 下，Node 内置模块默认 external、运行时由主进程 Node 解析，
 *   导致 host 半「事实已能」`require('node:http')` / `node:fs` / `node:child_process` 等
 *   触达联网 / 文件读写 / 进程执行能力，且当前无任何护栏。
 * - 此前的越权审计只拦 `electron` / `@shanhai/*`（selfmod.ts:99），不拦 node 内置模块。
 *
 * 阶段0 落地策略（暂不拒绝）：`HARD_BLOCK_DANGEROUS_NODE_MODULES` 默认 `false`，
 * 命中危险模块仅「告警」不拒绝加载，避免破坏已安装、正在使用这些能力的插件
 * （如 shortdrama 用 `child_process`/`http`/`https`/`fs`，fruit-ninja 用 `fs`）。
 * 待阶段1/2 受控桥就绪 + 相关插件迁移后，再打开硬拦截。
 */

/** 危险 node 内置模块（需拦：联网 / 文件读写 / 进程执行 / 任意代码执行 / 敏感能力） */
export const DANGEROUS_NODE_MODULES = [
  // 网络
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:dns',
  'node:dns/promises',
  // 文件系统
  'node:fs',
  'node:fs/promises',
  // 进程 / 线程
  'node:child_process',
  'node:worker_threads',
  'node:cluster',
  // 任意代码执行 / 反射（可绕过 require 限制或调式越权）
  'node:vm',
  'node:module',
  'node:repl',
  'node:inspector',
] as const

/** 无害纯计算 / 编码类 node 内置模块（保留给插件正常用，不产生联网/文件读写/进程执行） */
export const SAFE_NODE_MODULES = [
  'node:crypto',
  'node:path',
  'node:buffer',
  'node:util',
  'node:events',
  'node:url',
  'node:querystring',
  'node:string_decoder',
  'node:os',
  'node:stream',
  'node:zlib',
  'node:assert',
  'node:timers',
] as const

/** 硬拦截开关：阶段0 默认 false（告警不拒绝）；阶段1/2 受控桥就绪后再置 true */
export const HARD_BLOCK_DANGEROUS_NODE_MODULES = false

/**
 * 从 host.cjs 产物源码里找出 `require("node:xxx")` 命中的危险内置模块名（去重、保持清单顺序）。
 * 用闭合引号精确匹配，`node:fs` 不会误匹配 `node:fs/promises`。
 */
export function auditHostDangerousModules(src: string): string[] {
  const hits: string[] = []
  for (const mod of DANGEROUS_NODE_MODULES) {
    const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\brequire\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`)
    if (re.test(src)) hits.push(mod)
  }
  return hits
}

/**
 * 从 host.cjs 产物源码里找出命中的「无害」node 内置模块（去重、保持清单顺序）。
 * 用于审计日志里佐证「这些纯计算/编码模块不在拦截范围，已放行」，以及阶段1/2 硬拦截时
 * 区分「危险→拦 / 无害→放 / 未知→默认拦」的边界。
 */
export function auditHostSafeModules(src: string): string[] {
  const hits: string[] = []
  for (const mod of SAFE_NODE_MODULES) {
    const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\brequire\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`)
    if (re.test(src)) hits.push(mod)
  }
  return hits
}