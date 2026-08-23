import type { Skill, SkillAction } from '@shanhai/skills'
import type { ToolContract } from '@shanhai/tools'
import type { BrowserUseService } from './browser-use'
import { createBrowserUseTools, type UploadImageFn } from './tools'

/**
 * 把「操作内置浏览器」封装成可执行技能（skill），而非直接暴露 17 个独立工具。
 *
 * 对齐「一切皆插件」理念：AI 先 skill_list 发现、skill_read 读手册拿到脚本清单，
 * 再通过统一入口 skill_run('browser-use', action, params) 执行。底层 BrowserUseService 不变。
 *
 * 浏览器定位为「测试 / 查资料」用途，所有 action 免审批（不弹审批框，直接执行）。
 */
export function createBrowserUseSkill(service: BrowserUseService, uploadImage?: UploadImageFn): Skill {
  const actions: SkillAction[] = createBrowserUseTools(service, uploadImage).map((tool) => toSkillAction(tool))
  return {
    id: 'browser-use',
    name: '浏览器使用',
    description: '操作内置浏览器（导航 / 点击 / 输入 / 截图 / 提取 / 网络 / Cookie），用于测试与查资料',
    source: 'builtin',
    instructions: [
      '当需要访问网页、验证前端页面、提取网页数据、测试交互流程时使用。',
      '',
      '执行步骤：',
      '1. 先 skill_run(\'browser-use\', \'navigate\', {url}) 打开目标页面。',
      '2. 观察页面：优先用 get_content（提取文本）/ evaluate（执行 JS）读取内容，必要时才 screenshot 截图。',
      '3. 截图会返回 imageUrl（https 链接）。如需理解截图内容，调 image_analyze(imageUrl) 分析；当前模型支持视觉时可直接查看。',
      '4. 交互：用 click（点击）、type（输入）操作页面元素。',
      '5. 排查错误：先 get_console_logs 看控制台、get_network_requests 看请求，再决定是否截图。',
      '',
      '原则：',
      '- 截图前必须有明确目的，禁止无目的连续截图。',
      '- 选择器优先用稳定标识（id / name / data-testid），其次 CSS 选择器。',
      '- 页面跳转/异步加载后用 wait 等待关键元素就绪再操作。',
      '- 所有操作免审批，直接执行。',
      '',
      '多窗口：用 create 创建新窗口（返回 appId），后续操作传 appId 定位；list 列出当前窗口。',
    ].join('\n'),
    actions,
  }
}

/** 把工具契约转换为技能脚本：name 去掉 browser_ 前缀作为 action 名，参数说明从 inputSchema 提取 */
function toSkillAction(tool: ToolContract): SkillAction {
  const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
  const params: Record<string, string> = {}
  for (const [key, meta] of Object.entries(props)) {
    params[key] = meta?.description ?? ''
  }
  const required = (tool.inputSchema as { required?: string[] }).required ?? []
  return {
    name: tool.name.replace(/^browser_/, ''),
    description: tool.description,
    params,
    required: Array.isArray(required) ? required : [],
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    execute: tool.execute,
  }
}
