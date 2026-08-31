import { promises as fs, existsSync } from 'node:fs'
import { join, resolve, basename, sep } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SCAFFOLD_WORKSPACE_DIR } from './scaffold'

const execFileAsync = promisify(execFile)

/**
 * 插件共享包打包（任务 1/4：打包导出能力）。
 *
 * 只允许打包「自己开发的」插件工程：工程目录必须在 ~/.shanhai/plugins-workspace/<id>/ 下，
 * 禁止从 ~/.shanhai/plugins/（已安装目录，可能含市场安装的他人插件）打包共享。
 *
 * 共享包 zip 结构（接收方既可安装运行、也可二次开发）：
 *   manifest.json        （根，插件元数据 + hasUI/categories 分类字段）
 *   icon.* / assets/     （图标）
 *   src/                 （工程源码：host.ts、App.tsx、main.tsx 等）
 *   dist/                （构建产物：host.cjs、client.html、assets/*）
 *   package.json / tsconfig.json / vite.config.ts / README.md / client.html 等工程配置
 *
 * hasUI/categories 判定：
 *   - hasUI    = dist/client.html 存在（有界面窗口）
 *   - categories = 调用方传入（行业场景分类），缺省 ["其他"]（提示可改）
 */

/** 插件市场行业场景分类枚举（插件市场筛选用） */
export const PACKAGE_SHARE_CATEGORIES = [
  '效率办公',
  '内容创作',
  '视频生成',
  '设计',
  '数据分析',
  '生活工具',
  '行业专属',
  '其他',
] as const

export type PackageShareCategory = (typeof PACKAGE_SHARE_CATEGORIES)[number]

/** 共享包 manifest（= InstalledPackageMeta 子集 + 市场分类字段；路径一律相对 zip 根） */
export interface ShareManifest {
  id: string
  /** 网关提交接口要求的插件标识（= id），供市场/提交链路按键索引；与 id 保持一致 */
  plugin_id?: string
  name: string
  purpose: string
  version?: string
  icon?: string
  permissions?: string[]
  /** 有无界面窗口（有 dist/client.html 即 true） */
  hasUI: boolean
  /** 行业场景分类（枚举见 PACKAGE_SHARE_CATEGORIES，缺省 ["其他"]） */
  categories: string[]
  /** host 半产物相对路径（dist/host.cjs），有则写 */
  entryHost?: string
  /** client 半窗口入口相对路径（dist/client.html），有则写 */
  entryHtml?: string
  /** 打包时间戳 */
  shareAt: number
}

export interface PackageShareOptions {
  /** 行业分类（可多选，须在 PACKAGE_SHARE_CATEGORIES 内；缺省 ["其他"]） */
  categories?: string[]
  /** zip 输出目录（缺省 = ~/.shanhai/plugins-workspace/） */
  outDir?: string
}

export interface PackageShareResult {
  /** 共享 zip 绝对路径 */
  zipPath: string
  /** 打包进 zip 的 manifest（含 hasUI/categories 判定结果） */
  manifest: ShareManifest
  /** zip 文件字节数 */
  size: number
  /** zip 内条目清单（相对 zip 根，供验证） */
  entries: string[]
}

/** 校验分类值：不合法则过滤并给出提示（非法值剔除，剩余为空则落 ["其他"]） */
function normalizeCategories(raw?: string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return ['其他']
  const known = new Set<string>(PACKAGE_SHARE_CATEGORIES as readonly string[])
  const valid = raw.filter((c) => known.has(String(c)))
  return valid.length > 0 ? valid : ['其他']
}

/** 探测工程图标（返回相对工程根路径，无则 undefined）：icon.svg / icon.png / assets/icon.svg / assets/icon.png */
function resolvePluginIcon(projectDir: string): string | undefined {
  const candidates = ['icon.svg', 'icon.png', 'assets/icon.svg', 'assets/icon.png']
  for (const c of candidates) {
    if (existsSync(join(projectDir, c))) return c
  }
  return undefined
}

/** 归档时排除的目录/文件（node_modules 体积大且接收方需自行 install；dist 必须保留） */
const EXCLUDE_DIRS = new Set(['node_modules', '.git'])
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/** 递归收集工程文件相对路径清单（staging 复制 + zip 条目验证用） */
async function collectProjectFiles(projectDir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue
        await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      } else {
        if (EXCLUDE_FILES.has(e.name)) continue
        out.push(rel ? `${rel}/${e.name}` : e.name)
      }
    }
  }
  await walk(projectDir, '')
  return out.sort()
}

/** 创建 zip（跨平台）：darwin/linux 用系统 zip；win32 用 PowerShell Compress-Archive */
async function createZip(stagingDir: string, outFile: string): Promise<void> {
  if (process.platform === 'win32') {
    // Compress-Archive 条目不带 ./ 前缀（更干净）；Get-ChildItem -Force 含隐藏文件
    const ps = [
      'param($src,$dst)',
      'Get-ChildItem -Force -Path $src | Compress-Archive -DestinationPath $dst -CompressionLevel Optimal',
    ].join('; ')
    const { stdout, stderr } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      ps,
      stagingDir,
      outFile,
    ])
    if (stderr) throw new Error(`创建 zip 失败: ${stderr}`)
    return
  }
  const { stdout, stderr } = await execFileAsync('zip', ['-qr', outFile, '.'], { cwd: stagingDir })
  void stdout
  if (stderr) throw new Error(`创建 zip 失败: ${stderr}`)
}

/** 列出 zip 内条目（相对 zip 根；darwin/linux 用 unzip -l，win32 用 tar -tf） */
async function listZipEntries(zipPath: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('tar', ['-tf', zipPath])
    return stdout.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^\.\//, ''))
  }
  const { stdout } = await execFileAsync('unzip', ['-l', zipPath])
  // unzip -l 输出末两行是汇总，条目在第 4 列（文件名）
  const lines = stdout.split(/\r?\n/)
  const entries: string[] = []
  for (const line of lines) {
    const m = /^\s*\d+\s+[\d-]+\s+[\d:]+\s+(.+)$/.exec(line)
    if (m) entries.push((m[1] ?? '').replace(/^\.\//, ''))
  }
  return entries
}

/**
 * 打包一个本地插件工程为共享 zip。
 *
 * @param projectDirOrId 工程目录绝对路径，或仅 id（自动定位到 ~/.shanhai/plugins-workspace/<id>/）。
 *                       【安全】最终目录必须落在 plugins-workspace 内，否则拒绝。
 */
export async function packagePluginShare(
  projectDirOrId: string,
  opts: PackageShareOptions = {},
): Promise<PackageShareResult> {
  const raw = String(projectDirOrId ?? '').trim()
  if (!raw) throw new Error('缺少插件工程 id 或目录')

  const workspaceRoot = resolve(SCAFFOLD_WORKSPACE_DIR)
  // 传 id（无路径分隔符）→ 拼到 workspace 下；传绝对/相对路径 → resolve 后强制校验落在 workspace 内
  const looksLikeId = !raw.includes('/') && !raw.includes('\\')
  const projectDir = resolve(looksLikeId ? join(workspaceRoot, raw) : raw)
  if (projectDir !== workspaceRoot && !projectDir.startsWith(workspaceRoot + sep)) {
    throw new Error(`共享打包仅允许 ~/.shanhai/plugins-workspace/ 下的自研插件工程，拒绝：${projectDir}`)
  }
  if (!existsSync(projectDir)) throw new Error(`插件工程不存在：${projectDir}`)

  const id = basename(projectDir)
  const pkgJsonPath = join(projectDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`不是插件工程（缺 package.json）：${projectDir}`)
  }

  // 读工程 package.json + 已安装 manifest（permissions / 显示名 / 实际安装版本优先）
  const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as Record<string, unknown>
  const installedManifestPath = join(homedir(), '.shanhai', 'plugins', id, 'manifest.json')
  let installedMeta: Record<string, unknown> | null = null
  if (existsSync(installedManifestPath)) {
    try {
      installedMeta = JSON.parse(await fs.readFile(installedManifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      installedMeta = null
    }
  }

  // 判定 hasUI（有 dist/client.html 即有界面窗口）与 icon
  const hasUI = existsSync(join(projectDir, 'dist', 'client.html'))
  const hasHost = existsSync(join(projectDir, 'dist', 'host.cjs'))
  const icon = resolvePluginIcon(projectDir)

  const manifest: ShareManifest = {
    id,
    plugin_id: id,
    name: (installedMeta?.name as string) || (pkg.name as string) || id,
    purpose: (installedMeta?.purpose as string) || (pkg.description as string) || '',
    version: (installedMeta?.version as string) || (pkg.version as string),
    ...(icon ? { icon } : {}),
    permissions: Array.isArray(installedMeta?.permissions)
      ? (installedMeta.permissions as string[])
      : [],
    hasUI,
    categories: normalizeCategories(opts.categories),
    ...(hasHost ? { entryHost: 'dist/host.cjs' } : {}),
    ...(hasUI ? { entryHtml: 'dist/client.html' } : {}),
    shareAt: Date.now(),
  }

  // staging：把工程文件复制到临时目录，manifest.json 放根，再打包
  const stagingRoot = join(workspaceRoot, '.share-staging')
  const stagingDir = join(stagingRoot, id)
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(stagingDir, { recursive: true })

  const relFiles = await collectProjectFiles(projectDir)
  for (const rel of relFiles) {
    const from = join(projectDir, rel)
    const to = join(stagingDir, rel)
    await fs.mkdir(join(to, '..'), { recursive: true })
    await fs.copyFile(from, to)
  }
  await fs.writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  // 输出 zip
  const outDir = resolve(opts.outDir ?? workspaceRoot)
  await fs.mkdir(outDir, { recursive: true })
  const safeVersion = String(manifest.version ?? '0.0.0').replace(/[^\w.\-]+/g, '-')
  const zipPath = join(outDir, `${id}-v${safeVersion}.share.zip`)
  await createZip(stagingDir, zipPath)

  // 清理 staging
  await fs.rm(stagingRoot, { recursive: true, force: true })

  const entries = await listZipEntries(zipPath)
  const stat = await fs.stat(zipPath)
  return { zipPath, manifest, size: stat.size, entries }
}
