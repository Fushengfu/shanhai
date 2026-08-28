import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Capability } from '../types'

export type DynamicPackageStatus = 'defined' | 'running' | 'stopped' | 'installed'

/** 动态 package（仅内存态：不落盘、不存活重启、会话级隔离） */
export interface DynamicPackage {
  id: string
  name: string
  purpose: string
  code?: string
  client?: string
  version?: string
  status: DynamicPackageStatus
  sessionId: string
  capabilities?: Capability
  /** 插件声明的权限清单（plugin:invoke 白名单能力名，install 时随 manifest 落盘并审批）。缺省 = 空数组 = 最小权限 */
  permissions?: string[]
  /** host 半编译产物绝对路径（dist/host.cjs，第 3 步起支持；install 时探测填充，替代 node:vm 源码字符串） */
  entryHost?: string
  /** client 半编译产物绝对路径（dist/client.html，第 2 步起支持；install 时探测填充，替代 new Function 源码字符串） */
  entryHtml?: string
  /** 图标相对路径（相对插件目录，如 icon.png / assets/icon.png；第 4 步起支持，供 Dock 图标渲染用） */
  icon?: string
  /** 依赖声明（包名 → 版本，仅供工程化插件的 package.json 参考/审计，运行时不自解析依赖） */
  dependencies?: Record<string, string>
}

export interface InspectReport {
  /** 当前已知的服务名（由上层注入） */
  services: string[]
  /** 动态 package 列表 */
  packages: DynamicPackage[]
}

/**
 * 动态插件清单（K5 自修改）。
 *
 * 对应 DSH extensions 机制的 plugin_inspect / plugin_define / plugin_stop / plugin_undefine：
 * 只读报告、记录 package、撤回、遗忘。plugin_run 的 vm 沙箱评估在 runtime 层集成审批后执行。
 */
export class PluginInventory {
  private readonly packages = new Map<string, DynamicPackage>()
  private counter = 0

  /** plugin_define：记录 package（语法检查不运行），返回卡片。id 可选（restore 恢复已安装插件时指定稳定 id） */
  define(def: {
    name: string
    purpose: string
    code?: string
    client?: string
    version?: string
    sessionId: string
    id?: string
    permissions?: string[]
    entryHost?: string
    entryHtml?: string
    icon?: string
    dependencies?: Record<string, string>
  }): DynamicPackage {
    const id = def.id ?? `dyn-${++this.counter}`
    const pkg: DynamicPackage = {
      id,
      name: def.name,
      purpose: def.purpose,
      code: def.code,
      client: def.client,
      version: def.version,
      status: 'defined',
      sessionId: def.sessionId,
      permissions: def.permissions ?? [],
      entryHost: def.entryHost,
      entryHtml: def.entryHtml,
      icon: def.icon,
      dependencies: def.dependencies,
    }
    this.packages.set(pkg.id, pkg)
    return pkg
  }

  get(id: string): DynamicPackage | undefined {
    return this.packages.get(id)
  }

  list(): DynamicPackage[] {
    return [...this.packages.values()]
  }

  setStatus(id: string, status: DynamicPackageStatus): void {
    const pkg = this.packages.get(id)
    if (pkg) pkg.status = status
  }

  /** 变更 id（install 时把临时 dyn-<n> 改成稳定持久化 id） */
  rename(oldId: string, newId: string): void {
    const pkg = this.packages.get(oldId)
    if (!pkg) throw new Error(`动态包不存在: ${oldId}`)
    this.packages.delete(oldId)
    pkg.id = newId
    this.packages.set(newId, pkg)
  }

  /** 变更会话归属（install 后置为全局 '*'） */
  setSession(id: string, sessionId: string): void {
    const pkg = this.packages.get(id)
    if (pkg) pkg.sessionId = sessionId
  }

  /** plugin_undefine：停止并遗忘定义 */
  remove(id: string): void {
    this.packages.delete(id)
  }

  /** plugin_inspect：只读报告（services 由上层注入，packages 为动态包列表） */
  inspect(services: string[] = []): InspectReport {
    return {
      services,
      packages: this.list(),
    }
  }
}

/** 已安装插件的持久化元数据（manifest.json 内容） */
export interface InstalledPackageMeta {
  id: string
  name: string
  purpose: string
  version?: string
  code?: string
  client?: string
  installedAt: number
  /** 已审批的权限清单（plugin:invoke 白名单能力名，install 时随 manifest 落盘） */
  permissions?: string[]
  /** host 半编译产物绝对路径（dist/host.cjs，第 3 步起支持） */
  entryHost?: string
  /** client 半编译产物绝对路径（dist/client.html，第 2 步起支持） */
  entryHtml?: string
  /** 图标相对路径（相对插件目录，如 icon.png / assets/icon.png；第 4 步起支持，供 Dock 图标渲染用） */
  icon?: string
  /** 附加资源相对路径索引（相对插件目录，可选；供窗口/Dock 按需加载静态资源） */
  assets?: string[]
  /** 依赖声明（包名 → 版本，仅供工程化插件的 package.json 参考/审计，运行时不自解析依赖） */
  dependencies?: Record<string, string>
  /** 落盘形态：source=快速原型（仅 code/client 源码字符串），bundled=工程化（含 dist 编译产物）。缺省按字段推断 */
  kind?: 'source' | 'bundled'
}

/**
 * 持久化插件仓库（K5 自修改的落盘层）。
 *
 * 与 PluginInventory（仅内存态、会话隔离）互补：PluginStore 把「验证通过」的插件
 * 落盘到 ~/.shanhai/plugins/<id>/manifest.json（权限 600），使 AI 自研的应用能
 * 跨会话、跨重启留存，启动时由上层 loadAll 恢复并重新激活。
 *
 * 安全：id 只允许 [a-zA-Z0-9_-]，且 resolve 后强制校验落在仓库目录内，杜绝路径穿越。
 */
export class PluginStore {
  constructor(private readonly dir: string) {}

  /** 校验插件 id 合法性并返回其落盘目录（防路径穿越） */
  private pkgDir(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`非法插件 id（仅允许字母/数字/下划线/连字符）: ${id}`)
    }
    const root = resolve(this.dir)
    const target = resolve(this.dir, id)
    if (target !== join(root, id) && !target.startsWith(root + sep)) {
      throw new Error(`插件 id 越界: ${id}`)
    }
    return target
  }

  /** 返回插件编译产物文件绝对路径（dist/host.cjs 或 dist/client.html，不判断存在性，id 需合法）。第 3 步起用 */
  entryFile(id: string, kind: 'host' | 'client'): string {
    return join(this.pkgDir(id), 'dist', kind === 'host' ? 'host.cjs' : 'client.html')
  }

  /**
   * 返回插件目录内某个资源的绝对路径（第 4 步起：icon / assets 等相对插件目录的文件）。
   * 路径穿越防御：拒绝绝对路径、拒绝含 `..` 的相对路径、resolve 后强制落在插件目录内。
   * 返回 undefined 表示非法路径（不抛错，供调用方按「无此资源」降级处理）。
   */
  resourceFile(id: string, rel: string): string | undefined {
    if (!rel || rel.startsWith('/') || rel.includes('..')) return undefined
    const dir = this.pkgDir(id)
    const target = resolve(dir, rel)
    if (target !== join(dir, rel) && !target.startsWith(dir + sep)) return undefined
    return target
  }

  /** 安装：落盘 manifest.json（覆盖式，重装即更新） */
  async install(meta: InstalledPackageMeta): Promise<void> {
    const dir = this.pkgDir(meta.id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(meta, null, 2), { mode: 0o600 })
  }

  /** 卸载：删除整个插件目录（不存在的 id 静默成功） */
  async uninstall(id: string): Promise<void> {
    const dir = this.pkgDir(id)
    await fs.rm(dir, { recursive: true, force: true })
  }

  /** 读取单个已安装插件的元数据（不存在/损坏返回 undefined） */
  async load(id: string): Promise<InstalledPackageMeta | undefined> {
    const dir = this.pkgDir(id)
    try {
      const raw = await fs.readFile(join(dir, 'manifest.json'), 'utf8')
      const meta = JSON.parse(raw) as InstalledPackageMeta
      if (typeof meta?.id !== 'string' || meta.id !== id) return undefined
      if (typeof meta?.name !== 'string') return undefined
      return meta
    } catch {
      return undefined
    }
  }

  /** 列出所有已安装插件（目录不存在返回空，单个损坏跳过） */
  async list(): Promise<InstalledPackageMeta[]> {
    let entries
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: InstalledPackageMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = await this.load(entry.name)
      if (meta) out.push(meta)
    }
    return out
  }
}
