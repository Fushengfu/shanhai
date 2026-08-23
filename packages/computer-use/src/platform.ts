import { createMockComputerUseService, type ComputerUseService } from './computer-use'
import { createDarwinComputerUseService } from './darwin'
import { createWin32ComputerUseService } from './win32'
import { createLinuxComputerUseService } from './linux'

/**
 * 按运行平台分发 computer-use 底层实现：
 * - darwin：screencapture 截图 + Vision OCR + osascript 键鼠
 * - win32：System.Drawing 截图 + tesseract.js OCR + user32 P/Invoke 键鼠
 * - linux：import/scrot 截图 + tesseract.js OCR + xdotool 键鼠
 * - 其他：mock 兜底（空操作）
 */
export function createPlatformComputerUseService(): ComputerUseService {
  switch (process.platform) {
    case 'darwin':
      return createDarwinComputerUseService()
    case 'win32':
      return createWin32ComputerUseService()
    case 'linux':
      return createLinuxComputerUseService()
    default:
      return createMockComputerUseService()
  }
}
