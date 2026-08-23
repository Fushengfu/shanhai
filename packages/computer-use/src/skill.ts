import type { Skill, SkillAction } from '@shanhai/skills'
import type { ToolContract } from '@shanhai/tools'
import type { ComputerUseService } from './computer-use'
import { createComputerUseTools, type UploadImageFn } from './tools'

/**
 * 把「操作电脑桌面」封装成可执行技能（skill），而非直接暴露 3 个独立工具。
 *
 * 对齐「一切皆插件」理念：AI 先 skill_list 发现、skill_read 读手册拿到脚本清单，
 * 再通过统一入口 skill_run('computer-use', action, params) 执行。底层 ComputerUseService 不变。
 *
 * 铁律：桌面操作必须先截图识别再行动，禁止不截图直接盲操作。
 * 风险：screenshot / ocr 只读免审批；action（点击/输入/按键）为不可逆桌面操作，默认需审批。
 */
export function createComputerUseSkill(service: ComputerUseService, uploadImage?: UploadImageFn): Skill {
  const actions: SkillAction[] = createComputerUseTools(service, uploadImage).map((tool) => toSkillAction(tool))
  return {
    id: 'computer-use',
    name: '电脑使用',
    description: '操作电脑桌面（截图 / OCR 定位 / 鼠标键盘 / 滚动），用于桌面应用交互与系统操作',
    source: 'builtin',
    instructions: [
      '当需要截取桌面屏幕、识别界面文字、点击/操作桌面应用或系统 UI 时使用。',
      '',
      '铁律：必须先截图识别再行动，禁止不截图直接盲操作。',
      '',
      '完整闭环：',
      '1. skill_run(\'computer-use\', \'screenshot\', {}) 截取当前屏幕，返回 imageUrl（https 链接）。',
      '2. skill_run(\'computer-use\', \'ocr\', {}) 识别文字及精确坐标（文字类按钮/菜单用它定位，免猜坐标）；纯图标再用 image_analyze 视觉分析。',
      '3. skill_run(\'computer-use\', \'action\', {action, x, y / text / key ...}) 执行点击/输入/按键。',
      '4. 再次 screenshot 验证结果。',
      '',
      'action 的坐标必须来自 screenshot + ocr 的结果，禁止猜测。',
      '注意：action（点击/输入/按键）为不可逆桌面操作，默认会请求用户确认。',
    ].join('\n'),
    actions,
  }
}

/** 把工具契约转换为技能脚本：name 去掉 computer_ 前缀作为 action 名，参数说明从 inputSchema 提取 */
function toSkillAction(tool: ToolContract): SkillAction {
  const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
  const params: Record<string, string> = {}
  for (const [key, meta] of Object.entries(props)) {
    params[key] = meta?.description ?? ''
  }
  const required = (tool.inputSchema as { required?: string[] }).required ?? []
  return {
    name: tool.name.replace(/^computer_/, ''),
    description: tool.description,
    params,
    required: Array.isArray(required) ? required : [],
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    execute: tool.execute,
  }
}
