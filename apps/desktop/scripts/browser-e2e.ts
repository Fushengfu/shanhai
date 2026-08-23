import { app } from 'electron'
import { bootstrap } from '@shanhai/runtime'
import { createElectronBrowserService } from '../src/main/browser'

/**
 * 浏览器插件端到端验证：在真实 Electron 环境里，用真实网关模型 + 真实内置浏览器后端，
 * 让 agent 自主调用浏览器技能完成一个查资料任务，并验证：
 * 1. agent 自主调用 skill_run('browser-use', ...) 执行浏览器脚本（不是 curl/run_command）
 * 2. 返回内容确为 example.com 页面内容
 * 3. listBrowserWindows 能列出当前会话的浏览器窗口
 * 4. 窗口 appId 按会话隔离
 */
app.whenReady().then(async () => {
  try {
    const runtime = await bootstrap({ browserUse: createElectronBrowserService() })
    const sid = runtime.createSession('浏览器端到端验证')
    runtime.switchSession(sid)

    const traces: string[] = []
    runtime.onToolTrace((trace) => {
      if (trace.kind === 'tool-call' && trace.name === 'skill_run') {
        const skillId = (trace.args as { skillId?: string } | undefined)?.skillId
        traces.push(`skill_run:${skillId}`)
      } else if (trace.kind === 'tool-call') {
        traces.push(trace.name)
      }
    })

    console.log('=== 开始 agent 任务（真实网关 + 真实浏览器）===')
    const result = await runtime.run(
      '请使用浏览器技能打开 https://example.com 这个网页，然后告诉我这个网页的标题和正文主要内容。必须使用浏览器技能（先 skill_list / skill_read 读 browser-use 手册，再 skill_run 执行），不要用 run_command 或 curl。',
    )
    console.log('=== RESULT_START ===')
    console.log(result)
    console.log('=== RESULT_END ===')

    const usedBrowser = traces.some((n) => n.startsWith('skill_run:browser-use'))
    console.log('=== TOOL_TRACES ===')
    console.log(traces.join(' -> '))
    console.log('agent 是否调用浏览器技能:', usedBrowser)

    const wins = await runtime.listBrowserWindows(sid)
    console.log('=== BROWSER_WINDOWS ===')
    console.log(JSON.stringify(wins, null, 2))
    const hasWindow = wins.length > 0
    const appIdOk = wins.every((w) => w.appId === sid || w.appId.startsWith(`${sid}:`))

    // 验证会话隔离：新建会话 B，看不到会话 A 的浏览器窗口
    const sidB = runtime.createSession('会话B')
    const winsB = await runtime.listBrowserWindows(sidB)
    console.log('=== ISOLATION ===')
    console.log('会话B窗口数（应为 0）:', winsB.length)
    const isolated = winsB.length === 0

    // 验证关闭：关闭会话 A 的窗口后，窗口列表清空（agent 的 browser_close 与 UI 手动关闭同走 close）
    if (wins[0]) await runtime.closeBrowserWindow(wins[0].appId)
    const winsAfterClose = await runtime.listBrowserWindows(sid)
    console.log('=== CLOSE ===')
    console.log('关闭后会话A窗口数（应为 0）:', winsAfterClose.length)
    const closed = winsAfterClose.length === 0

    const hit = /example/i.test(result) || /Example Domain/i.test(result)

    console.log('=== VERIFY ===')
    console.log('返回页面内容:', hit)
    console.log('调用浏览器工具:', usedBrowser)
    console.log('有浏览器窗口:', hasWindow)
    console.log('窗口会话隔离:', appIdOk)
    console.log('会话间隔离:', isolated)
    console.log('关闭窗口生效:', closed)

    if (!(hit && usedBrowser && hasWindow && appIdOk && isolated && closed)) process.exitCode = 1

    await runtime.kernel.dispose()
  } catch (err) {
    console.error('=== E2E_FAILED ===')
    console.error(err)
    process.exitCode = 1
  }
  app.quit()
})
