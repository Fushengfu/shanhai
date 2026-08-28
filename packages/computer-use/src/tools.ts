import type { ToolContract } from '@shanhai/tools'
import type { ComputerAction, ComputerUseService } from './computer-use'

/** 截图上传回调：把 base64 上传到云存储，返回 https 公网链接；失败返回 null（调用方回退 base64） */
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
  return [screenshotTool(service, uploadImage), ocrTool(service), actionTool(service)]
}

/** computer_screenshot：截取当前屏幕，返回截图链接（上传云存储后的 https URL）；失败回退 base64 */
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
      if (uploadImage) {
        try {
          const url = await uploadImage(base64)
          if (url) return { imageUrl: url, byteLength: bytes.length }
        } catch {
          // 上传失败：回退 base64（保证截图功能不失效）
        }
      }
      return { imageBase64: base64, byteLength: bytes.length }
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

/** computer_action：统一桌面动作（点击/双击/输入/按键/滚动） */
function actionTool(service: ComputerUseService): ToolContract {
  return {
    name: 'computer_action',
    description:
      '执行一个桌面动作。action 取值：click（左键单击，需 x/y 屏幕坐标）、doubleClick（双击，需 x/y）、type（在当前焦点输入文字，需 text）、key（按下按键，如 enter/tab/space/escape/up/down 等，需 key）、scroll（滚动，direction 为 up/down，可选 amount 行数）。坐标必须先由 computer_screenshot + computer_ocr/视觉分析获得，禁止猜测。注意：截图是 Retina 物理像素，OCR 返回的 x/y 是像素坐标，直接原样传入即可（底层自动换算为逻辑点坐标），不要手动 ÷2。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'doubleClick', 'type', 'key', 'scroll'], description: '动作类型' },
        x: { type: 'number', description: '屏幕 x 坐标（click/doubleClick 必填）' },
        y: { type: 'number', description: '屏幕 y 坐标（click/doubleClick 必填）' },
        text: { type: 'string', description: '要输入的文本（type 必填）' },
        key: { type: 'string', description: '按键名（key 必填）' },
        direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向（scroll 必填）' },
        amount: { type: 'number', description: '滚动行数（scroll 可选，默认 3）' },
      },
      required: ['action'],
    },
    riskLevel: 'irreversible',
    approvalRequired: true,
    execute: async (args) => {
      const action = parseAction(args)
      switch (action.action) {
        case 'click':
          await service.clickAt(action.x, action.y)
          break
        case 'doubleClick':
          await service.doubleClickAt(action.x, action.y)
          break
        case 'type':
          await service.typeText(action.text)
          break
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
