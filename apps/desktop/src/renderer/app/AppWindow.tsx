import * as React from 'react'
import { useEffect, useState } from 'react'
import { getUiStoreSnapshot, patchUiStore, useUiStore } from '../store-client'
import { getAppManifest, appNameOf } from '../apps/registry'
import { MemoryPanel } from '../components/MemoryPanel'
import { SettingsPanel } from '../components/SettingsPanel'
import { TracePanel } from '../components/TracePanel'
import { CustomModelDrawer } from '../components/CustomModelDrawer'
import { TerminalPanel } from '../components/TerminalPanel'
import { WallpaperPanel } from '../components/WallpaperPanel'
import { PluginMarketApp } from '../apps/PluginMarketApp'
import { SkillMarketApp } from '../apps/SkillMarketApp'
import { McpManagerApp } from '../apps/McpManagerApp'
import { MemberPanel } from '../components/MemberPanel'
import { useThemeSync } from '../theme'
import { applyLocale, useLocaleSync } from '../locale'
import { t } from '../../shared/i18n'

/**
 * 插件应用窗口（多窗口桌面系统的独立应用）。
 * 根据 appId 渲染对应面板（variant='window' 全窗口布局）。trace 应用额外订阅流式事件实时显示执行过程。
 */
export function AppWindow({ appId }: { appId: string }): React.JSX.Element {
  const manifest = getAppManifest(appId)
  const ui = useUiStore()
  /**
   * 【任务223】本窗口的「目标会话」：主进程在建窗时经 additionalArguments 注入（argv，每个窗口各一份，
   * 不用跨窗口全局字段 —— 那正是 222 修过的串台 bug 的风险面）。
   * undefined = 未指定 → 各处回落到 ui.currentSessionId，**与本改动前逐字节等价**。
   * 典型用法：会话侧顶栏点「记忆/轨迹」= 不传（看当前会话）；管家面板点同一对按钮 =
   * openApp('memory'|'trace', 'supervisor')（看管家自己的数据）。
   */
  const targetSessionId = window.shanhai?.windowAppSessionId
  /** 会话类应用实际要展示的会话：显式指定优先，否则回落 currentSessionId */
  const sessionId = targetSessionId ?? ui.currentSessionId
  const close = (): void => {
    void window.shanhai?.closeApp(appId)
  }

  // 【期4C 重扫补修】本窗口自己会渲染应用展示名（下方 default 分支的 appNameOf），
  // 而窗口级 onLocaleChange 回调只 applyLocale、不 setState —— 光靠它本组件不会重渲染。
  // 补上取词订阅，切语言时标题才会跟着变（这也是「AppWindow 到底靠什么重渲染」的答案）。
  useLocaleSync()

  // 主题：订阅主进程广播，跟随聊天窗口切换（亮/暗实时同步）
  useThemeSync()

  // 语言：同上，订阅 ui:locale 广播。私信面板（MemberPanel）就渲染在本窗口里，
  // 不订阅的话会出现「聊天窗口切了英文、私信窗口还是中文」。
  useEffect(() => {
    const off = window.shanhai?.onLocaleChange((l) => applyLocale(l))
    return off
  }, [])

  // trace 应用：订阅广播的流式事件，实时显示当前会话执行过程（busy 恒 false，思考态由 streamingReasoning 承载）
  const [streaming, setStreaming] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  useEffect(() => {
    if (appId !== 'trace') return
    const sid = sessionId
    setStreaming('')
    setStreamingReasoning('')
    if (!sid) return
    const offDelta = window.shanhai?.onDelta((s, text) => {
      if (s === sid) setStreaming((p) => p + text)
    })
    const offReasoning = window.shanhai?.onReasoning((s, text) => {
      if (s === sid) setStreamingReasoning((p) => p + text)
    })
    return () => {
      offDelta?.()
      offReasoning?.()
    }
  }, [appId, sessionId])

  // 模型管理应用：增删改查走 IPC，结果 patch 到主进程 store（聊天窗口自动同步）
  const customModels = ui.models.filter((m) => m.custom)
  const handleAddModel = async (input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }): Promise<void> => {
    const m = await window.shanhai?.addCustomModel(input)
    if (m) {
      patchUiStore({ models: [...getUiStoreSnapshot().models, m], selectedModel: m.id })
      void window.shanhai?.switchModel(m.id)
    }
  }
  const handleUpdateModel = async (id: string, input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic'; contextLength?: number; supportsVision?: boolean }): Promise<void> => {
    const m = await window.shanhai?.updateCustomModel(id, input)
    if (m) patchUiStore({ models: getUiStoreSnapshot().models.map((x) => (x.id === id ? m : x)) })
  }
  const handleRemoveModel = async (id: string): Promise<void> => {
    await window.shanhai?.removeCustomModel(id)
    const snap = getUiStoreSnapshot()
    const models = snap.models.filter((m) => m.id !== id)
    // 删除的是当前选中模型时，同步清空 selectedModel，避免 UI 选中态指向已删除的模型
    const selectedModel = snap.selectedModel === id ? '' : snap.selectedModel
    patchUiStore({ models, selectedModel })
  }
  const handleSelectModel = (id: string): void => {
    patchUiStore({ selectedModel: id })
    void window.shanhai?.switchModel(id)
  }

  switch (appId) {
    case 'memory':
      // sessionId 为 undefined 时 MemoryPanel 内部回落 currentSessionId（与原行为一致）
      return <MemoryPanel variant="window" sessionId={targetSessionId} onClose={close} />
    case 'settings':
      return <SettingsPanel variant="window" onClose={close} />
    case 'trace':
      return (
        <TracePanel
          variant="window"
          sessionId={sessionId}
          busy={false}
          streamingReasoning={streamingReasoning}
          streaming={streaming}
          onClose={close}
        />
      )
    case 'models':
      return (
        <CustomModelDrawer
          variant="window"
          models={customModels}
          onClose={close}
          onAdd={handleAddModel}
          onUpdate={handleUpdateModel}
          onRemove={handleRemoveModel}
          onSelect={handleSelectModel}
        />
      )
    case 'terminal':
      return <TerminalPanel variant="window" sessionId={ui.currentSessionId} open={true} onClose={close} />
    case 'wallpaper':
      return <WallpaperPanel variant="window" onClose={close} />
    case 'marketplace':
      return <PluginMarketApp onClose={close} />
    case 'skills-market':
      // 技能市场（第三方技能搜索 / 详情审计 / 安装）：入口在账号悬停弹窗的「技能」区
      return <SkillMarketApp onClose={close} />
    case 'mcp-manager':
      // MCP 管理（本机 MCP 服务的编辑 / 启停）：入口在账号悬停弹窗的「MCP 服务」区
      return <McpManagerApp onClose={close} />
    case 'messages':
      // 会员私信与好友（内置 App 窗口，走 window.shanhai 的 member:* 接口，不经插件白名单）
      return <MemberPanel onClose={close} />
    default:
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            overflow: 'hidden',
            fontFamily: 'system-ui, sans-serif',
            background: 'var(--bg-app)',
            color: 'var(--text)',
          }}
        >
          <header
            style={
              {
                padding: '12px 16px 12px 80px',
                borderBottom: '1px solid var(--border)',
                fontWeight: 600,
                fontSize: 14,
                WebkitAppRegion: 'drag',
              } as React.CSSProperties
            }
          >
            {manifest ? appNameOf(manifest) : appId}
          </header>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            {t('app.unknownApp', { id: appId })}
          </div>
        </div>
      )
  }
}
