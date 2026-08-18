import { bootstrap, type Runtime } from '@shanhai/runtime'
import { createElectronBrowserService } from '../main/browser'

/** boot host：装配内核 + 能力插件，注入 Electron 内置浏览器后端，返回运行时句柄 */
export function bootHost(): Promise<Runtime> {
  return bootstrap({ browserUse: createElectronBrowserService() })
}
