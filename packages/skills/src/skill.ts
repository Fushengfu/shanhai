import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { RiskLevel } from '@shanhai/tools'

/**
 * 复合技能（Skill）：一个技能 = 名称 + 描述 + 给 agent 的操作指南。
 *
 * 与原子工具（read_file / run_command）不同，技能是「如何组合使用原子工具完成某类任务」的说明书：
 * agent 通过 skill_list 发现可用技能、通过 skill_read 读取手册，然后按手册步骤调用原子工具执行。
 *
 * 技能分两类：
 * 1. 纯说明书技能（instructions 只有文字，无 actions）——技能本身不直接执行代码，
 *    安全边界由它所引用的原子工具的审批/风险等级统一约束（如内置 code-review / code-search）。
 * 2. 可执行技能（含 actions）——把「一组底层能力」封装成脚本，agent 通过统一的
 *    skill_run(skillId, action, params) 执行，底层实现不直接暴露为顶层工具（如 browser-use / computer-use）。
 */

/** 可执行技能的单个脚本（action）：一个 action = 名称 + 描述 + 参数说明 + 风险 + 执行函数 */
export interface SkillAction {
  /** 脚本名（skill_run 的 action 参数） */
  name: string
  /** 一句话描述（skill_read 返回时展示给 AI） */
  description: string
  /** 参数说明：参数名 -> 描述（写进 skill_read 返回的清单，供 AI 填参） */
  params: Record<string, string>
  /** 必填参数名 */
  required?: string[]
  /** 风险等级（审批粒度到 action 级；缺省回退技能默认） */
  riskLevel?: RiskLevel
  /** 是否需审批（browser-use 全部免审批；computer-use 的桌面动作需审批） */
  approvalRequired?: boolean
  /** 执行函数 */
  execute: (params: Record<string, unknown>) => unknown | Promise<unknown>
}

export interface Skill {
  /** 唯一 id（用户技能目录取目录名，内置/可执行技能取固定 id） */
  id: string
  /** 展示名 */
  name: string
  /** 一句话描述（何时用） */
  description: string
  /** 操作指南正文（SKILL.md 的正文部分，说明何时用、怎么用、注意事项） */
  instructions: string
  /** 来源：builtin（内置）| user（~/.shanhai/skills 用户技能目录） */
  source: 'builtin' | 'user'
  /** 可执行技能的脚本清单（纯说明书技能无此字段） */
  actions?: SkillAction[]
}

/** 内置技能：开箱即用，体现技能格式。用户可在 ~/.shanhai/skills/ 下追加自定义技能覆盖。 */
const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'code-review',
    name: '代码审查',
    description: '修改代码后自动检查潜在问题，按严重程度给出审查建议',
    source: 'builtin',
    instructions: [
      '当用户提交或修改代码、要求检查代码质量时使用。',
      '',
      '执行步骤：',
      '1. 用 read_file 读取被修改的代码文件（大文件先 list_dir 定位再分块读）。',
      '2. 检查：命名是否自解释、单函数是否 ≤50 行、是否滥用 any 与非空断言、I/O 是否 try-catch、是否处理空值/极值/并发。',
      '3. 安全检查：SQL/命令是否参数化防注入、密钥是否脱敏、路径是否 resolve 后校验在工作目录内、是否硬编码凭证。',
      '4. 输出按严重程度（致命/警告/建议）分级的审查结果，每条给出文件 + 行号 + 原因。',
    ].join('\n'),
  },
  {
    id: 'code-search',
    name: '代码搜索',
    description: '在项目中按关键字或文件名定位代码/内容',
    source: 'builtin',
    instructions: [
      '当需要查找某个函数、关键字、文件位置时使用。',
      '',
      '优先用 run_command 执行 `grep -rn "关键字" .` 递归搜索并显示行号；',
      '按文件名查找用 `find . -name "*.ts" -path "*/src/*"`。',
      '搜索不到时拆分关键词、扩大范围重试；最后才 read_file 整文件，避免大文件整读。',
    ].join('\n'),
  },
  {
    id: 'plugin-protocol',
    name: '插件协议规范',
    description: '山海插件（selfmod/K5 自修改）的权威契约：host/client 半写法、生命周期、落盘格式与坑清单。开发任何插件前必读。',
    source: 'builtin',
    instructions: [
      '本文是山海 AI「插件（selfmod / K5 自修改）」的权威、唯一协议规范。AI 开发插件前必须先读本文，禁止靠猜或试错。',
      '',
      '一个插件 = 一个动态 package（DynamicPackage），由两段源码字符串组成（可只提供其一）：',
      '- host 半（code）：运行在进程内（Node vm 沙箱），入口 module.exports = (ctx) => disposer，用于注册服务/事件/工具、开关窗口；',
      '- client 半（client）：运行在浏览器渲染进程（new Function 编译），两种形态，用于挂 UI 组件或渲染独立窗口。',
      '动态 package 默认仅内存态：plugin_define 只记录不落盘；只有 plugin_install 才落盘持久化。plugin_define 产生的 package 归当前会话；plugin_install 后 sessionId 置为 "*"（全局）。',
      '',
      '=== 一、host 半契约 ===',
      '入口必须 module.exports = (ctx) => disposer（不能写裸箭头函数，否则 vm 沙箱取不到导出会报错「host 半代码必须导出函数」）。',
      'ctx 提供五条能力（HostFacade）：',
      '1. ctx.on(name, listener)：订阅内核事件总线，撤销时自动 off；',
      '2. ctx.provide(name, impl)：注册命名服务到内存 map（当前仅被 plugin_inspect 报告，无服务发现/注入消费）；',
      '3. ctx.tools.register(tool)：向全局工具表注册 model-facing 工具，撤销时自动移除（全局、非会话隔离）；',
      '4. ctx.openWindow(appId?)：打开本插件窗口应用（appId 缺省 = 插件 id），并自动注册撤销（stop/uninstall/test 撤回时自动关闭该窗口）；',
      '5. ctx.closeWindow(appId?)：显式关闭本插件窗口应用（appId 缺省 = 插件 id），不挂撤销。',
      '刻意不暴露 effect()：host 半 cleanup 只能走上面 4 条自动撤销路径（on/provide/tools.register/openWindow），从机制上杜绝裸副作用导致无法热插拔。',
      'disposer 可为 函数 / null / Iterable(逐个 yield) / Promise，撤销时逆序全部调用，单个失败不阻断其余。',
      'ctx.tools.register 的 ToolContract 字段：name、description（隐式 prompt）、inputSchema（JSON Schema）、riskLevel(readonly/reversible/irreversible/high)、approvalRequired?、timeoutMs?、guide?、resolveRisk?、execute。',
      '',
      '=== 二、client 半契约（两种形态，二选一）===',
      'client 半用 new Function 编译、不经过 JSX，写组件必须用 React.createElement(...)，禁止写 <div> 这类 JSX 语法。',
      '形态 A：UI 插槽形态（默认，投递到聊天窗口）——',
      '  契约函数体：function(React, slots, useUIContext){ slots.register({ slot, id, component }) }',
      '  三个入参：React（命名空间）、slots（只有 register 一个方法，非完整 SlotRegistry）、useUIContext（组件内读取应用状态）。',
      '  slots.register({ slot, id, component })：slot=目标插槽名；id=包内注册 id（拼成 `${pkgId}:${id}`）；component=React 函数组件（内部可调 useUIContext()）。',
      '  返回值若为函数，作为该包 browser 半 disposer 存起来（卸载时调用）。',
      '形态 B：窗口应用形态（配合 host 半 openWindow）——',
      '  契约函数体：function(React, helpers){ return 组件函数 }',
      '  helpers = { close, appId, name }：close() 调 window.shanhai.closeApp(appId) 关窗；appId=插件持久化 id；name=插件名。',
      '  必须 return 一个 React 组件函数（function XxxWindow() {...}），不能 return 对象、不能箭头函数直接返回对象；返回非函数时窗口显示「插件未提供窗口界面」占位。',
      '  窗口形态在独立 app 渲染进程执行、不在 UIContext.Provider 内，因此不能调 useUIContext()，只能用 helpers。',
      '',
      '=== 三、UI 插槽清单（CORE_SLOTS）===',
      '覆盖型（后注册整体替换、注销回退）：shell.sidebar / shell.header / shell.chat / shell.composer / shell.statusbar / shell.terminal / shell.welcome / shell.panels / shell.overlays / dynamic-extension；',
      '追加型（全部注册依次渲染、互不覆盖）：composer.below / composer.actions / header.actions / chat.below。',
      '想「加按钮/小组件」优先用追加型，不要用覆盖型替换整个区块。',
      '',
      '=== 四、生命周期（define → test → install → run/stop → uninstall）===',
      '状态机：defined → running → stopped → installed。',
      'plugin_define：记录 package（不语法检查、不运行），返回 dyn-<n> id，不落盘；',
      'plugin_run：vm 评估 host 半 + 投递 client 半（有 client 时 round-trip 审批），不落盘；',
      'plugin_stop：撤销 host 半（disposer）+ browser 半（removeClient），定义保留；',
      'plugin_undefine：stop 后遗忘定义；',
      'plugin_test：幂等「撤回→运行→撤回」，返回 { ok, clientDelivered }，不落盘；',
      'plugin_install：见下，落盘；',
      'plugin_uninstall：disposer + removeClient + 删落盘文件；',
      '启动 restoreAll：加载所有已安装插件重新激活（免审批）。',
      'plugin_install 精确顺序：校验→persistIdOf 生成持久化 id（name 转 kebab-case，仅允许 [a-zA-Z0-9_-]）→同名已安装先 uninstall（视为升级）→若 running 先 stop→rename(dynId,persistId)+setSession("*")→run(id,sid,{skipApproval:true}) 激活→store.install 落盘 manifest.json→setStatus(installed)。',
      'openWindow/closeWindow 配对：openWindow 挂 stack.collect(closeAppWindow) 自动撤销，因此 stop/uninstall/test 撤回时已打开窗口自动关闭；closeWindow 只主动关闭不挂撤销。',
      '注意：ctx.openWindow() 在 run 阶段被调用，plugin_install/plugin_run 一执行完窗口就已弹出（不是「装完只挂 Dock 图标、点图标才开窗」）。若产品预期「点 Dock 图标才开窗」，host 半不要在 run 阶段直接调 openWindow，应把开窗交给 Dock 图标点击触发的 openApp 链路。',
      '',
      '=== 五、落盘格式 ===',
      '~/.shanhai/plugins/<id>/manifest.json（权限 0o600，目录名 = id）：',
      '{ "id":"todo-list","name":"待办清单","purpose":"...","version":"1.0.0","code":"module.exports = (ctx)=>{...}","client":"function(React,slots,useUIContext){...}","installedAt":1720000000000 }',
      'id 仅允许 [a-zA-Z0-9_-]，resolve 后强制校验落在仓库目录内，杜绝路径穿越；uninstall 删除整个 <id> 目录。',
      '',
      '=== 六、坑速查 ===',
      '1. host 半必须 module.exports = (ctx) => disposer，不能裸箭头函数；',
      '2. client 半 new Function 编译、不经过 JSX，必须 React.createElement；',
      '3. 窗口应用形态必须 return 组件函数，不能 return 对象/箭头函数返回对象；',
      '4. 窗口应用形态不能 useUIContext()（独立进程、不在 Provider 内），只用 helpers；',
      '5. UI 插槽形态的 slots 只有 register 一个方法；',
      '6. openWindow 在 run 阶段即开窗，install 时窗口立即弹出（非点击 Dock 才开）；',
      '7. host 半无 effect()，cleanup 只走 4 条自动撤销路径；',
      '8. tools.register 注册的是全局工具（ctx.tools.push），非会话隔离；',
      '9. provide 的服务仅 plugin_inspect 报告用，目前无服务发现/注入机制消费它；',
      '10. client 半源码字符串跨渲染进程传输（序列化），主进程 plugin-apps 维护 appId → { name, clientCode }，Dock 图标经 plugin-apps:changed 广播刷新。',
    ].join('\n'),
  },
]

/** frontmatter 里支持的元数据字段（简单行解析，不引入 yaml 依赖） */
interface SkillFrontmatter {
  name?: string
  description?: string
}

/**
 * 技能服务（能力缝 Provider）：负责技能发现、读取与可执行技能注册。
 *
 * 来源三级：可执行技能（代码内注册，handler 在内存，优先级最高）
 *          + 内置技能（代码内置，开箱即用）
 *          + 用户技能目录（~/.shanhai/skills/<id>/SKILL.md）。
 * 每个用户技能是一个目录，内含 SKILL.md：frontmatter（name/description）+ 正文（instructions）。
 * 首次 list 时扫描并缓存；id 唯一，覆盖优先级：可执行技能 > 用户技能 > 内置技能。
 */
export class SkillService {
  private cache: Skill[] | null = null
  /** 可执行技能（handler 在代码内，如 browser-use / computer-use） */
  private executables: Skill[] = []

  constructor(private readonly skillsDir: string = join(homedir(), '.shanhai', 'skills')) {}

  /** 注册可执行技能；优先级高于内置与用户技能（handler 在代码内，不可被 SKILL.md 覆盖） */
  registerExecutable(skill: Skill): void {
    this.executables.push(skill)
    this.cache = null
  }

  /** 列出所有可用技能（可执行 + 内置 + 用户目录） */
  async list(): Promise<Skill[]> {
    if (this.cache) return this.cache
    const user = await this.loadUserSkills()
    const merged = new Map<string, Skill>()
    for (const s of [...BUILTIN_SKILLS, ...user, ...this.executables]) merged.set(s.id, s)
    this.cache = [...merged.values()]
    return this.cache
  }

  /** 按 id 读取技能（含 instructions 手册全文与 actions 清单） */
  async read(id: string): Promise<Skill | undefined> {
    const skills = await this.list()
    return skills.find((s) => s.id === id)
  }

  /** 按 skillId + action 查找可执行动作（供 skill_run 执行与动态风险解析） */
  async findAction(skillId: string, action: string): Promise<SkillAction | undefined> {
    const skill = await this.read(skillId)
    return skill?.actions?.find((a) => a.name === action)
  }

  /**
   * 内置可执行技能目录文本（注入系统提示词，让 AI 开局即知有哪些内置能力）。
   * 只含 source=builtin 且带 actions 的可执行技能（browser-use / computer-use / terminal 等）；
   * 纯说明书内置技能（code-review 等）与第三方用户技能（~/.shanhai/skills）不注入，
   * 由 AI 在需要时通过 skill_list 主动查询。
   */
  async builtinExecutableCatalog(): Promise<string> {
    const skills = await this.list()
    const executables = skills.filter((s) => s.source === 'builtin' && s.actions && s.actions.length > 0)
    if (executables.length === 0) return ''
    return executables.map((s) => `- ${s.id}（${s.name}）：${s.description}`).join('\n')
  }

  /** 扫描用户技能目录，返回解析后的技能列表（目录不存在或技能损坏时静默跳过） */
  private async loadUserSkills(): Promise<Skill[]> {
    let entries
    try {
      entries = await fs.readdir(this.skillsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: Skill[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const mdPath = join(this.skillsDir, entry.name, 'SKILL.md')
      try {
        const raw = await fs.readFile(mdPath, 'utf8')
        const skill = this.parseSkillMarkdown(entry.name, raw)
        if (skill) out.push(skill)
      } catch {
        // 单个技能读取失败不影响其他技能
      }
    }
    return out
  }

  /** 解析 SKILL.md：frontmatter（---...---）取元数据，其余为 instructions 正文 */
  private parseSkillMarkdown(id: string, raw: string): Skill | undefined {
    const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/)
    let meta: SkillFrontmatter = {}
    let instructions = raw
    if (match) {
      instructions = (match[2] ?? '').trim()
      meta = this.parseFrontmatter(match[1] ?? '')
    }
    const name = meta.name?.trim() || id
    const description = meta.description?.trim() || ''
    if (!instructions) return undefined
    return { id, name, description, instructions, source: 'user' }
  }

  /** 逐行解析 frontmatter 的 `key: value` 对 */
  private parseFrontmatter(block: string): SkillFrontmatter {
    const meta: SkillFrontmatter = {}
    for (const line of block.split('\n')) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
      if (!kv) continue
      const key = kv[1]!
      const value = (kv[2] ?? '').trim()
      if (key === 'name') meta.name = value
      else if (key === 'description') meta.description = value
    }
    return meta
  }
}
