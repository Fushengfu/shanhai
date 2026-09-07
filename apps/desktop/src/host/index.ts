import { bootstrap, type Runtime } from '@shanhai/runtime'
import { createElectronBrowserService } from '../main/browser'
import { createElectronTerminalService } from '../main/terminal'
import { sendDmFromAgent, getFriendsSnapshot, listThreads } from '../main/member-channel'

/** boot host：装配内核 + 能力插件，注入 Electron 内置浏览器与 node-pty 终端后端，返回运行时句柄 */
export function bootHost(): Promise<Runtime> {
  return bootstrap({
    browserUse: createElectronBrowserService(),
    terminalUse: createElectronTerminalService(),
    // 私信发消息桥：委托 member-channel 的安全门（dmAutoReply 开关 + 出站敏感信息硬拦截）
    dmUse: {
      async sendFromAgent(input) {
        return sendDmFromAgent(input ?? { text: '' })
      },
      // 只读列好友（dm_friends 工具后端）：复用 member-channel 既有内存缓存（friends/threads 单一真相源），
      // 按 memberId 关联拼上未读数与最后一条消息时间；keyword 过滤在内存里做，零网络请求，绝不返回私信正文。
      async listFriends(keyword) {
        const { friends } = getFriendsSnapshot()
        const threads = listThreads()
        const kw = (keyword ?? '').trim().toLowerCase()
        const items = friends
          .filter(
            (f) =>
              !kw ||
              (f.nickname ?? '').toLowerCase().includes(kw) ||
              f.username.toLowerCase().includes(kw),
          )
          .map((f) => {
            const th = threads.find((t) => t.peerId === f.memberId)
            return {
              memberId: f.memberId,
              username: f.username,
              ...(f.nickname ? { nickname: f.nickname } : {}),
              ...(typeof f.online === 'boolean' ? { online: f.online } : {}),
              ...(th ? { unread: th.unread, lastTs: th.lastTs } : {}),
            }
          })
        return {
          ok: true,
          count: items.length,
          friends: items,
          notice:
            'memberId 仅用于调用 dm_send，不得出现在给用户看的回复里；unread/lastTs 为会话级元数据，不含任何私信正文。',
        }
      },
    },
  })
}
