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
