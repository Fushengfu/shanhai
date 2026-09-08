import type { ToolContract } from '@shanhai/tools'
import type { ComputerAction, ComputerUseService, PerformActionParams } from './computer-use'

/** 截图上传回调：把 base64 上传到云存储，返回 https 公网链接；失败返回 null 或抛异常（调用方返回失败原因，绝不回退 base64） */
export type UploadImageFn = (imageBase64: string) => Promise<string | null>

/**
 * computer-use 插件：把「操作电脑」收敛为三个统一工具，形成「截图 → 定位 → 动作 → 验证」闭环。
 *
 * - computer_screenshot：截取当前屏幕（只读），拿到画面后需 OCR/视觉分析再行动
 * - computer_ocr：识别截图中的文字及精确像素坐标（只读），文字类 UI 元素用它定位，无需猜坐标
 * - computer_action：统一执行桌面动作（点击/双击/输入/按键/滚动），危险操作默认需审批
 *
 * 设计原则（对齐 Taco computer-use）：桌面操作必须先截图识别再行动，禁止盲操作。
 */
export function createComputerUseTools(service: ComputerUseService, uploadImage?: UploadImageFn): ToolContract[] {
  return [screenshotTool(service, uploadImage), ocrTool(service), readTreeTool(service), actionTool(service)]
}

/** computer_screenshot：截取当前屏幕，返回截图链接（上传云存储后的 https URL）；上传失败返回失败原因（不返回 base64） */
function screenshotTool(service: ComputerUseService, uploadImage?: UploadImageFn): ToolContract {
  return {
    name: 'computer_screenshot',
    description:
      '截取当前屏幕并返回截图链接（上传云存储后的 https URL）。用于查看桌面/窗口当前状态。任何需要点击、输入、判断界面状态的操作，第一步都必须先调用它截图，再配合 computer_ocr 或 image_analyze 定位，禁止不截图直接盲操作。',
    inputSchema: { type: 'object', properties: {} },
    riskLevel: 'readonly',
    execute: async () => {
      const buf = await service.screenshot()
      const bytes = new Uint8Array(buf)
      const base64 = Buffer.from(bytes).toString('base64')
      if (!uploadImage) {
        return { ok: false, error: `截图已生成（${bytes.length} 字节），但未配置云存储上传，无法返回截图链接`, byteLength: bytes.length }
      }
      try {
        const url = await uploadImage(base64)
        if (url) return { imageUrl: url, byteLength: bytes.length }
        return { ok: false, error: `截图已生成（${bytes.length} 字节），但上传云存储失败（未返回链接，可能未登录）`, byteLength: bytes.length }
      } catch (err) {
        return { ok: false, error: `截图已生成（${bytes.length} 字节），但上传云存储失败：${err instanceof Error ? err.message : String(err)}`, byteLength: bytes.length }
      }
    },
  }
}

/** computer_ocr：识别截图文字 + 精确坐标（文字类 UI 定位首选，免猜坐标） */
function ocrTool(service: ComputerUseService): ToolContract {
  return {
    name: 'computer_ocr',
    description:
      '识别截图中的文字及其精确坐标。返回每个文字块的中心点即精确点击坐标。用于定位按钮、菜单项、输入框等带文字的 UI 元素；纯图标/图片请改用 computer_screenshot + image_analyze。',
    inputSchema: {
      type: 'object',
      properties: {
        imageBase64: { type: 'string', description: '截图的 base64；不传则自动截取当前屏幕' },
      },
    },
    riskLevel: 'readonly',
    execute: async (args) => {
      const words = await service.ocr(typeof args.imageBase64 === 'string' ? args.imageBase64 : undefined)
      return { words }
    },
  }
}

/**
 * computer_read_tree：读当前前台应用的无障碍语义树（元素级定位首选）。
 * 委托宿主注入的 service.readTree（单一真相源 = computer-access 插件），不复制引擎。
 * 未装配 / 非 macOS / 读失败时返回可见降级原因，AI 应回落到 screenshot + ocr，禁止静默返回空树。
 */
function readTreeTool(service: ComputerUseService): ToolContract {
  return {
    name: 'computer_read_tree',
    description:
      '读当前前台 macOS 应用窗口的系统级无障碍语义树（角色/标题/值/位置尺寸，裁剪后的紧凑文本）。' +
      '用于元素级定位：拿到真实 UI 语义（按钮/输入框/文本/勾选态/几何坐标）后再决定点哪里、输入什么，替代「截图视觉估坐标盲点」。' +
      '输出有硬上限（限深/限节点/限字节/字段裁剪），超限时 truncated=true + 原因，绝不静默截断。' +
      '只做 macOS；未装配或非 macOS 或读不到时返回可见降级原因，此时请回落到 computer_screenshot + computer_ocr 定位。' +
      '能读任意前台 App 窗口全文，比截图更敏感，因此每次调用都需审批。',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: '目标进程 pid；0 或缺省 = 当前前台应用（正常只用这个）' },
        maxDepth: { type: 'number', description: '遍历最大深度，默认 18' },
        maxNodes: { type: 'number', description: '最多访问节点数，默认 800' },
        maxBytes: { type: 'number', description: '输出文本字节硬上限，默认 20000' },
        maxFieldLen: { type: 'number', description: '单字段字符裁剪长度，默认 120' },
        includeGeometry: { type: 'boolean', description: '是否输出位置尺寸，默认 true' },
      },
    },
    riskLevel: 'readonly',
    approvalRequired: true,
    execute: async (args) => {
      if (typeof service.readTree !== 'function') {
        return { ok: false, degraded: true, reason: 'readTree_unavailable', message: '当前平台/宿主未装配无障碍读树（仅 macOS 且需 computer-access 插件），请改用 computer_screenshot + computer_ocr 定位' }
      }
      try {
        return await service.readTree(args as never)
      } catch (err) {
        return { ok: false, degraded: true, reason: 'readTree_failed', message: `无障碍读树失败：${err instanceof Error ? err.message : String(err)}。请改用 computer_screenshot + computer_ocr 定位` }
      }
    },
  }
}

/** computer_action：统一桌面动作（无障碍 role+text 定位写操作 / 坐标点击 / 双击 / 输入 / 按键 / 滚动） */
function actionTool(service: ComputerUseService): ToolContract {
  return {
    name: 'computer_action',
    description:
      '执行一个桌面动作。两条路径：\n' +
      '①【首选·无障碍元素定位】传 targetRole 和/或 targetText，走系统级 AX 定位写操作：action=press（点击）/increment（加）/decrement（减）/setValue（设值，需 value）。' +
      '定位到元素后执行并做「防假成功」回读，三态返回 success（回读到变化）/unconfirmed（已送达但未确认生效）/failed（定位不到/disabled/被门禁拒）。' +
      'unconfirmed 不要当成功，也不要当失败重试，请回读确认。必须先用 computer_read_tree 拿到目标元素的 role+文本再精确传入，禁止猜文本。' +
      '②【兜底·坐标路径】不传 targetRole/targetText 时走坐标：action=click（需 x/y）/doubleClick（需 x/y）/type（需 text）/key（需 key）/scroll（direction+amount）。' +
      '坐标必须先由 computer_screenshot + computer_ocr/视觉分析获得，禁止猜测。截图是 Retina 物理像素，OCR 返回的 x/y 原样传入即可（底层自动换算），不要手动 ÷2。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'doubleClick', 'type', 'key', 'scroll', 'press', 'increment', 'decrement', 'setValue'], description: '动作类型（无障碍路径用 press/increment/decrement/setValue，坐标路径用 click/doubleClick/type/key/scroll）' },
        x: { type: 'number', description: '屏幕 x 坐标（click/doubleClick 必填）' },
        y: { type: 'number', description: '屏幕 y 坐标（click/doubleClick 必填）' },
        text: { type: 'string', description: '要输入的文本（type 必填）' },
        key: { type: 'string', description: '按键名（key 必填）' },
        direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向（scroll 必填）' },
        amount: { type: 'number', description: '滚动行数（scroll 可选，默认 3）' },
        targetRole: { type: 'string', description: '无障碍定位：AX 角色精确匹配（如 AXButton/AXTextField/AXCheckBox），可空；与 targetText 至少填一个即走无障碍路径' },
        targetText: { type: 'string', description: '无障碍定位：文本子串（归一化后匹配 title/value/desc），可空；与 targetRole 至少填一个即走无障碍路径' },
        value: { type: 'string', description: '无障碍路径 setValue 时写入的文本' },
        pid: { type: 'number', description: '无障碍路径：目标进程 pid；0 或缺省 = 当前前台应用' },
      },
      required: ['action'],
    },
    riskLevel: 'irreversible',
    approvalRequired: true,
    execute: async (args) => {
      // 无障碍元素定位写操作路径（二期）：传了 targetRole 或 targetText 即走插件 AX 定位写操作
      const targetRole = typeof args.targetRole === 'string' ? args.targetRole : ''
      const targetText = typeof args.targetText === 'string' ? args.targetText : ''
      if (targetRole || targetText) {
        return performActionViaPlugin(service, args)
      }
      // 坐标路径（既有）
      const action = parseAction(args)
      switch (action.action) {
        case 'click':
          // 缺陷②：坐标点击前校验「坐标处最上层窗口是否属于当前前台 App」，误点背景窗口时停下报错而非盲点
          if (typeof service.windowOwnerAtPoint === 'function') {
            const hit = await service.windowOwnerAtPoint(action.x, action.y)
            if (hit && !hit.matched && hit.ownerAtPoint) {
              return {
                ok: false,
                status: 'failed',
                action: 'click',
                reason: 'foreground_mismatch',
                message: `坐标 (${action.x}, ${action.y}) 处最上层窗口属于「${hit.ownerAtPoint}」，不是当前前台「${hit.frontmost || '未知'}」，点击会点到别的 App，已停止。请先聚焦要操作的目标 App 再点击。`,
              }
            }
          }
          await service.clickAt(action.x, action.y)
          break
        case 'doubleClick':
          await service.doubleClickAt(action.x, action.y)
          break
        case 'type':
          // 缺陷①：type 现在支持任意 Unicode（剪贴板+Cmd+V），且写入后回读校验，不再无条件 ok:true
          return await typeTextWithVerify(service, action.text)
        case 'key':
          await service.pressKey(action.key)
          break
        case 'scroll':
          await service.scroll(action.direction, action.amount)
          break
      }
      return { ok: true, action: action.action }
    },
  }
}

/** 归一化字符串用于比对：NFKC + 去零宽字符（U+200B–200F / U+FEFF / U+2060），对齐插件侧 normalize 口径 */
function normalizeForCompare(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\uFEFF\u2060]/g, '')
}

/**
 * 坐标路径 type 的执行 + 回读校验（缺陷①）：输入文本后必须回读确认，绝不「返回 ok:true 但界面没变」。
 * - typeText 失败（剪贴板方案抛错）→ failed
 * - 回读到前台窗口输入框 value 含写入文本 → success
 * - 回读不到变化 / 无回读能力 → unconfirmed（送达但未确认生效，不冒充成功）
 */
async function typeTextWithVerify(service: ComputerUseService, text: string) {
  try {
    await service.typeText(text)
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      action: 'type',
      message: `输入文本失败：${err instanceof Error ? err.message : String(err)}。`,
    }
  }
  if (typeof service.readTree !== 'function') {
    return {
      ok: false,
      status: 'unconfirmed',
      action: 'type',
      message: '文本已发送，但当前平台无回读能力，未确认是否写入界面。请用 computer_read_tree 或 computer_screenshot 二次确认。',
    }
  }
  try {
    const tree = await service.readTree({})
    const want = normalizeForCompare(text)
    const treeText = normalizeForCompare(typeof tree?.text === 'string' ? tree.text : '')
    if (want && treeText.includes(want)) {
      return { ok: true, status: 'success', action: 'type', message: '文本已写入并回读到相同内容。' }
    }
    return {
      ok: false,
      status: 'unconfirmed',
      action: 'type',
      message: '文本已发送，但未回读到界面变化（可能写到别处，或目标 App 不暴露输入框 value）。请用 computer_read_tree 或 computer_screenshot 二次确认。',
    }
  } catch (err) {
    return {
      ok: false,
      status: 'unconfirmed',
      action: 'type',
      message: `文本已发送，但回读校验失败：${err instanceof Error ? err.message : String(err)}。请用 computer_read_tree 或 computer_screenshot 二次确认。`,
    }
  }
}

/** 无障碍写操作路径：委托 service.performAction（→ computer-access 插件），三态如实透传，unconfirmed 绝不冒充 success */
async function performActionViaPlugin(service: ComputerUseService, args: Record<string, unknown>) {
  if (typeof service.performAction !== 'function') {
    return {
      ok: false,
      status: 'failed',
      degraded: true,
      reason: 'performAction_unavailable',
      message: '当前平台/宿主未装配无障碍写操作（仅 macOS 且需 computer-access 插件），请改用 computer_action 坐标路径（click/type/key/scroll）',
    }
  }
  const action = normalizePerformAction(String(args.action ?? ''))
  const targetRole = typeof args.targetRole === 'string' ? args.targetRole : ''
  const targetText = typeof args.targetText === 'string' ? args.targetText : ''
  const value = typeof args.value === 'string' ? args.value : ''
  const pid = Number(args.pid)
  const params: PerformActionParams = { action, targetRole, targetText, value, pid: Number.isFinite(pid) ? pid : 0 }
  if (Number.isFinite(Number(args.maxDepth))) params.maxDepth = Number(args.maxDepth)
  if (Number.isFinite(Number(args.maxNodes))) params.maxNodes = Number(args.maxNodes)
  try {
    const result = await service.performAction(params)
    // code-enforced 回读判据：unconfirmed 送达但未确认生效，不得报成功、不得当失败重试，附上二次确认引导
    if (result.status === 'unconfirmed') {
      return {
        ...result,
        ok: false,
        notice: '动作已送达但未回读到界面变化（按钮类 press 常如此，生效可能体现在别处，如计算器显示屏）。请用 computer_read_tree 或 computer_screenshot 二次确认是否真的生效；拿不准就如实报「已执行但未确认生效」。',
      }
    }
    if (result.status === 'success') {
      return { ...result, ok: true }
    }
    // failed：定位不到/disabled/门禁拒/动作不支持等，如实透传 reason 与 message
    return { ...result, ok: false }
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      degraded: true,
      reason: 'performAction_failed',
      message: `无障碍写操作失败：${err instanceof Error ? err.message : String(err)}。请改用 computer_action 坐标路径（click/type/key/scroll）。`,
    }
  }
}

/** 把模型传入的无障碍 action 归一化（默认 press；非法值响亮报错，避免执行 undefined） */
function normalizePerformAction(action: string): 'press' | 'increment' | 'decrement' | 'setValue' {
  if (action === '' || action === 'press') return 'press'
  if (action === 'increment' || action === 'decrement' || action === 'setValue') return action as 'increment' | 'decrement' | 'setValue'
  throw new Error(`computer_action 无障碍定位路径不支持的 action: ${action || '（空）'}（支持 press/increment/decrement/setValue）`)
}

/** 把模型传入的 args 解析成强类型 ComputerAction（缺失/非法字段响亮报错，避免执行 undefined） */
function parseAction(args: Record<string, unknown>): ComputerAction {
  const action = String(args.action ?? '')
  switch (action) {
    case 'click': {
      const x = Number(args.x)
      const y = Number(args.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('computer_action click 需要有效的 x/y 坐标')
      return { action: 'click', x, y }
    }
    case 'doubleClick': {
      const x = Number(args.x)
      const y = Number(args.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('computer_action doubleClick 需要有效的 x/y 坐标')
      return { action: 'doubleClick', x, y }
    }
    case 'type': {
      const text = String(args.text ?? '')
      if (!text) throw new Error('computer_action type 需要 text 参数')
      return { action: 'type', text }
    }
    case 'key': {
      const key = String(args.key ?? '')
      if (!key) throw new Error('computer_action key 需要 key 参数')
      return { action: 'key', key }
    }
    case 'scroll': {
      const direction = args.direction === 'down' ? 'down' : 'up'
      const amount = args.amount === undefined ? undefined : Number(args.amount)
      return { action: 'scroll', direction, amount }
    }
    default:
      throw new Error(`computer_action 不支持的 action: ${action || '（空）'}`)
  }
}
