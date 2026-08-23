import { bootstrap, type Runtime } from '@shanhai/runtime'
import { createElectronBrowserService } from '../main/browser'
import { createElectronTerminalService } from '../main/terminal'

/** boot host：装配内核 + 能力插件，注入 Electron 内置浏览器与 node-pty 终端后端，返回运行时句柄 */
export function bootHost(): Promise<Runtime> {
  return bootstrap({
    browserUse: createElectronBrowserService(),
    terminalUse: createElectronTerminalService(),
  })
}
