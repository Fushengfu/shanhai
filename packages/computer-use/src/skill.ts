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
    description: '操作电脑桌面（无障碍读树定位 / 截图 / OCR / 鼠标键盘 / 滚动），用于桌面应用交互与系统操作',
    source: 'builtin',
    instructions: [
      '当需要截取桌面屏幕、识别界面文字、点击/操作桌面应用或系统 UI 时使用。',
      '',
      '铁律：必须先定位再行动，禁止不定位直接盲操作。',
      '',
      '定位优先级（重要，首选读树，截图作兜底）：',
      '1. skill_run(\'computer-use\', \'read_tree\', {}) 读当前前台 macOS 应用的无障碍语义树，拿到元素真实语义（角色/标题/值）+ 几何坐标，据此决定点哪里/输入什么。',
      '   这是元素级定位：不靠截图视觉估坐标，抗分辨率/DPI/主题变化。',
      '   read_tree 每次调用都需审批（能读任意前台 App 窗口全文，比截图更敏感）。',
      '   read_tree 返回 degraded（未装配/非 macOS/无权限/读不到）时，如实回落到下面的截图+OCR 路径，禁止静默当作「读不到空树」。',
      '2. 首选写操作：skill_run(\'computer-use\', \'action\', {action, targetRole, targetText, value ...}) 按角色+文本定位元素并执行系统级 AX 写操作。',
      '   action 取值：press（点击）/ increment（加）/ decrement（减）/ setValue（设值，需 value）；targetRole（AX 角色，如 AXButton/AXTextField）+ targetText（文本子串，归一化后匹配）至少填一个，且必须来自 read_tree 的真实结果，禁止猜文本。',
      '   三态返回：success（回读到变化）/ unconfirmed（已送达但未确认生效，按钮 press 常如此，别当成功也别当失败重试，应再 read_tree 或 screenshot 确认）/ failed（定位不到/disabled/被门禁拒，看 reason）。',
      '3. 兜底写操作：不传 targetRole/targetText 时走坐标路径 skill_run(\'computer-use\', \'action\', {action: \'click\'|\'doubleClick\'|\'type\'|\'key\'|\'scroll\', x/y/text/key ...})。',
      '4. 兜底定位：skill_run(\'computer-use\', \'screenshot\', {}) 截当前屏幕返回 imageUrl；再 skill_run(\'computer-use\', \'ocr\', {}) 识别文字及精确坐标；纯图标用 image_analyze 视觉分析。',
      '5. 执行后再 read_tree（或 screenshot）验证结果。',
      '',
      'action 的定位（targetRole/targetText 或坐标）必须来自 read_tree / screenshot + ocr 的结果，禁止猜测。',
      '注意：action 为不可逆桌面操作（含无障碍写操作），每次调用都会请求用户确认，无论走元素定位还是坐标路径。',
      '点击后要回读验证：无障碍/键盘 API 可能「返回成功但没生效」，执行后应再 read_tree 或 screenshot 确认目标节点状态变化，拿不准就如实报「已执行但未确认生效」，别拿 API 返回值当成功证据。',
      '',
      '坐标换算（重要）：screencapture 截图是 Retina 物理像素（如 3600×2338 = 逻辑 1800×1169 × 2），OCR 返回的 x/y 是「截图像素坐标」，直接原样传给 action 即可，底层会自动 ÷ backingScaleFactor 换算成逻辑点坐标，不要手动 ÷2。',
      'click 走真实鼠标事件（CGEvent），可点击 Electron 应用按钮；依赖「辅助功能」权限（系统设置 → 隐私与安全 → 辅助功能 勾选山海），若 click 无效先检查该权限。',
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
