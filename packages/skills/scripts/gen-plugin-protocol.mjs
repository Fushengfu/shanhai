// 从 docs/plugin-protocol.md 生成 packages/skills/src/plugin-protocol.generated.ts
// 用途：让「插件协议」只有 docs 一份权威源，内置技能 plugin-protocol 的 instructions 由本文自动同步，
//       消除 docs/plugin-protocol.md 与 skill.ts 内置指令的双份维护漂移。
// 用法：pnpm --filter @shanhai/skills gen:protocol   （skills build 前会自动调用）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 脚本位于 packages/skills/scripts/，往上三级到仓库根
const repoRoot = join(__dirname, '..', '..', '..')
const docsPath = join(repoRoot, 'docs', 'plugin-protocol.md')
const outPath = join(__dirname, '..', 'src', 'plugin-protocol.generated.ts')

if (!existsSync(docsPath)) {
  console.error('[gen-plugin-protocol] 找不到权威源:', docsPath)
  process.exit(1)
}

const md = readFileSync(docsPath, 'utf8').replace(/^\uFEFF/, '')

const header = [
  '// 本文件由 scripts/gen-plugin-protocol.mjs 从 docs/plugin-protocol.md 自动生成，请勿手改。',
  '// 权威源唯一：docs/plugin-protocol.md（改协议只改 docs，再跑 `pnpm --filter @shanhai/skills gen:protocol` 同步）。',
  '',
  'export const PLUGIN_PROTOCOL_INSTRUCTIONS = ',
].join('\n')

// JSON.stringify 输出的是合法 JS 字符串字面量（双引号 + 转义），可直接作为 TS 字符串常量。
const out = header + JSON.stringify(md) + '\n'

writeFileSync(outPath, out, 'utf8')
console.log('[gen-plugin-protocol] 已生成', outPath, `(${Buffer.byteLength(md, 'utf8')} 字节，${md.length} 字符)`)
