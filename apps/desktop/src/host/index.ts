import { bootstrap, type Runtime } from '@shanhai/runtime'

/** boot host：装配内核 + 能力插件，返回运行时句柄 */
export function bootHost(): Promise<Runtime> {
  return bootstrap()
}
