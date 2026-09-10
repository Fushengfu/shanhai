/**
 * MCP 管理面板（McpManagerApp）的共用形状：主进程产出 / preload 桥 / 渲染层消费三处同源。
 *
 * 【凭证红线】`~/.shanhai/mcp.json` 的 `env` 里可能有用户真实凭证：
 *  - **主进程 → 渲染层只下发 `key` + 掩码值（masked）**，原始值一个字节都不下传；
 *  - **渲染层 → 主进程** 用 `value: null` 表示「这个键保持原值不变」——
 *    界面只拿得到掩码，物理上不可能把原值传回来，因此「把掩码写进文件」这条错路被类型本身堵死。
 *
 * 【启停口径】停用 = 把该条从 `servers` 段**移到 `disabledServers` 段**（配置不丢、格式向后兼容）。
 * `McpService` 只读 `servers`（packages/mcp/src/service.ts:36），故停用项对 AI 侧天然不可见。
 */

/** MCP 服务在管理面板里的一条（含启用状态与掩码后的 env） */
export interface McpManagedServer {
  id: string
  command: string
  args: string[]
  /** 是否启用（false = 在 disabledServers 段，AI 侧看不到） */
  enabled: boolean
  /** 工具数（仅启用项探测；未探测到 / 失败时见 toolError） */
  toolCount?: number
  /** 探测失败原因（未连接 / 超时 / 读取失败），有值时 toolCount 不可信 */
  toolError?: string
  /** env 的键名 + 掩码值（**原始值绝不下发**） */
  env: Array<{ key: string; masked: string }>
}

export interface McpManageListResult {
  servers: McpManagedServer[]
  /** 整体性错误（读文件/解析失败） */
  error?: string
}

/** 编辑保存的入参（渲染层 → 主进程） */
export interface McpServerPatch {
  id: string
  command: string
  args: string[]
  /**
   * env 目标态。`value === null` = 保持文件里的原值不变（界面显示的是掩码，改不了原值）；
   * `value` 为字符串 = 用户输入的新值（含空串 = 显式清空）。
   */
  env: Array<{ key: string; value: string | null }>
  /** 要删除的 env 键名（用户点了「移除」） */
  envRemoved: string[]
}

export interface McpManageResult {
  ok: boolean
  /** 失败原因（校验不通过 / 写盘失败 / 原子替换失败），必须可见、不许静默 */
  error?: string
}
