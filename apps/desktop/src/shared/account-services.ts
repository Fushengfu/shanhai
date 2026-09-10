/**
 * 账号悬停弹窗（AccountPopover）用到的「本机只读服务清单」类型。
 *
 * 【为什么放 shared】同一组形状被三处同时使用：主进程（main/skills-mcp.ts 产出）、
 * preload（桥签名）、渲染层（弹窗消费）。各写一份必然漂开（本项目反复踩过的「两份真相」），
 * 故统一提到本文件，三处一律 import type。
 *
 * 【只读口径 —— 只描述「展示所需的最小字段」】
 *  - skill 不含 instructions / actions：手册正文与脚本 execute 函数既不必要、也不可序列化；
 *  - mcp 服务器不含 env：~/.shanhai/mcp.json 的 env 里可能有凭证，**绝不下发渲染层**。
 */

/** 技能来源：builtin=内置（代码内置的说明书技能）/ user=~/.shanhai/skills 下的用户技能 */
export type SkillSource = 'builtin' | 'user'

/** 一条技能的展示字段（对应 SkillService.list() 的子集） */
export interface SkillSummary {
  id: string
  name: string
  description: string
  source: SkillSource
}

/** 一台已配置的 MCP 服务器（对应 McpService.listServers() 的完整返回，本身就不含 env） */
export interface McpServerSummary {
  id: string
  command: string
  args: string[]
}

/** 单台 MCP 服务器的工具数（探测失败/超时时 count=0 且带 error，不编数字） */
export interface McpToolCount {
  serverId: string
  count: number
  error?: string
}

export interface SkillListResult {
  skills: SkillSummary[]
  /** 整体性错误（单个用户技能读取失败由 SkillService 内部静默跳过，不会出现在这里） */
  error?: string
}

export interface McpServerListResult {
  servers: McpServerSummary[]
  /** 整体性错误（单台服务器的问题走 McpToolCount.error） */
  error?: string
}

export interface McpToolCountResult {
  results: McpToolCount[]
  error?: string
}
