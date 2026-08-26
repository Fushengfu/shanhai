import { registerSlot } from '../slots'

/**
 * shell.panels 插件：侧滑面板层。
 * 记忆 / 轨迹 / 设置 / 模型 / 终端 已全部迁为独立窗口应用（经 openApp 打开），
 * 此处保留空注册，供 selfmod 动态包按需替换/扩展侧滑面板区。
 */
function PanelsSlot(): null {
  return null
}

registerSlot('shell.panels', 'core:panels', 'core', PanelsSlot)
