/**
 * 技能市场（Skills Market）的共用形状：主进程产出、preload 桥、渲染层消费三处同源。
 *
 * 【与 shared/account-services.ts 的关系】那是「本机只读清单」（账号弹窗用），
 * 本文件是「远端市场 + 安装」（技能市场窗口用）。两者的 SkillSummary 不合并：
 * 前者只需要 id/name/description/source，后者还带 downloads/version/来源市场等字段，
 * 强行合一会让账号弹窗被迫处理它用不到的字段。
 *
 * 【安全口径】市场返回的是**第三方内容**，所有字段都按「不可信文本」处理：
 *  - 渲染层一律以纯文本渲染（不 dangerouslySetInnerHTML）；
 *  - 不含任何凭证字段，也不下发图片二进制（iconUrl 只透传 URL 字符串，不内联 base64）。
 */

/** 技能来源市场：clawhub（ClawHub）/ skillhub（腾讯 SkillHub） */
export type SkillMarketSource = 'clawhub' | 'skillhub'

/** 风险等级（与 SKILL.md 安全审计的判定口径一致） */
export type SkillRiskLevel = 'low' | 'medium' | 'high' | 'critical'

/** 搜索结果里的一条技能（已跨两个市场归一化） */
export interface SkillMarketItem {
  /** 市场内唯一标识（下载/详情都以它为键） */
  slug: string
  /** 展示名（可能含中文） */
  displayName: string
  /** 一句话描述（极长，UI 需截断） */
  summary: string
  /** 下载量（用于排序展示；缺失为 0） */
  downloads: number
  /** 市场标注的版本号（可能缺失） */
  version?: string
  /** 作者名（缺失时主进程填「未知」） */
  authorName: string
  /** 来自哪个市场 */
  source: SkillMarketSource
  /** 分类（skillhub 有，clawhub 无） */
  category?: string
  /** 星标数（skillhub 有） */
  stars?: number
  /** 安装数（skillhub 有） */
  installs?: number
  /** 本机 skills 目录下是否已有同名目录（渲染层据此显示「已安装」） */
  installed: boolean
}

/** 搜索响应 */
export interface SkillMarketSearchResult {
  items: SkillMarketItem[]
  /** 市场报告的总命中数（用于「共 N 条」展示，不做分页） */
  total: number
  /** 整体性错误（两个市场都不可达时为非空，UI 显示错误态而非空态） */
  error?: string
}

/** 安装前的详情 + 安全预览（第三方内容审计结果） */
export interface SkillPreview {
  slug: string
  source: SkillMarketSource
  /** 安装后将使用的本地目录名（由 slug 规范化得到；渲染层只展示，不可改） */
  id: string
  name: string
  description: string
  version: string
  author: string
  /** SKILL.md frontmatter 声明的依赖：需要哪些命令行 */
  requiresBins: string[]
  /** 需要哪些环境变量（只报变量名，不回显其值） */
  requiresEnv: string[]
  /** 本机当前**缺失**的命令行（安装不阻断，仅提示） */
  missingBins: string[]
  /** 本机当前**缺失**的环境变量名（同上） */
  missingEnv: string[]
  /** 综合风险等级（SKILL.md 正文 + scripts/ 脚本） */
  riskLevel: SkillRiskLevel
  /** 审计命中的告警条目（中文，来自既有审计规则） */
  warnings: string[]
  /** SKILL.md 全文（UI 展示在滚动区，纯文本渲染） */
  instructions: string
  /** 本机是否已安装同 id 技能 */
  installed: boolean
}

/** 安装结果 */
export interface SkillInstallResult {
  ok: boolean
  /** 安装成功的技能 id（= ~/.shanhai/skills 下的目录名） */
  id?: string
  /** 落盘绝对路径（仅用于「打开目录」一类的后续能力，本轮不展示） */
  dir?: string
  /** 本次安装实际落盘的文件相对路径清单（用于结果反馈，不含内容） */
  files?: string[]
  /** 风险等级高（high/critical）且调用方未确认时为 true，此时**没有安装任何东西** */
  needConfirm?: boolean
  /** 供确认界面复用的预览（仅在 needConfirm=true 时有意义） */
  preview?: SkillPreview
  error?: string
}

/**
 * 卸载结果。
 *
 * 【为什么卸载也走 main（而不是渲染层）】渲染层拿不到文件系统；卸载是**破坏性操作**，
 * 必须由主进程做「id 合法性 + 只能删 user 技能 + 路径夹取在 ~/.shanhai/skills 之内」三道校验，
 * 任何一道不过就如实报错，绝不「尽力而为」。
 */
export interface SkillUninstallResult {
  ok: boolean
  /** 被卸载的技能 id（= ~/.shanhai/skills 下的目录名） */
  id?: string
  /** 实际删除的目录绝对路径（仅用于结果反馈与排查） */
  dir?: string
  /** 失败原因（含校验不通过 / 目录不存在 / 删除失败），界面必须可见 */
  error?: string
}

/** 安装阶段（用于进度反馈：renderer 据此显示当前步骤） */
export type SkillInstallStage =
  | 'download'
  | 'verify'
  | 'extract'
  | 'audit'
  | 'commit'

/** 安装进度事件（主进程 → 发起安装的那个窗口） */
export interface SkillInstallProgress {
  slug: string
  stage: SkillInstallStage
  /** 0~100；未知阶段用 -1 表示「不确定进度」 */
  percent: number
}
