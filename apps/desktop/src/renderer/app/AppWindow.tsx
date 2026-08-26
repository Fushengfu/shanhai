import { useEffect, useState } from 'react'
import { getUiStoreSnapshot, patchUiStore, useUiStore } from '../store-client'
import { getAppManifest } from '../apps/registry'
import { MemoryPanel } from '../components/MemoryPanel'
import { SettingsPanel } from '../components/SettingsPanel'
import { TracePanel } from '../components/TracePanel'
import { CustomModelDrawer } from '../components/CustomModelDrawer'
import { TerminalPanel } from '../components/TerminalPanel'
import { WallpaperPanel } from '../components/WallpaperPanel'
import { useThemeSync } from '../theme'

/**
 * 插件应用窗口（多窗口桌面系统的独立应用）。
 * 根据 appId 渲染对应面板（variant='window' 全窗口布局）。trace 应用额外订阅流式事件实时显示执行过程。
 */
export function AppWindow({ appId }: { appId: string }): React.JSX.Element {
  const manifest = getAppManifest(appId)
  const ui = useUiStore()
  const close = (): void => {
    void window.shanhai?.closeApp(appId)
  }

  // 主题：订阅主进程广播，跟随聊天窗口切换（亮/暗实时同步）
  useThemeSync()

  // trace 应用：订阅广播的流式事件，实时显示当前会话执行过程（busy 恒 false，思考态由 streamingReasoning 承载）
  const [streaming, setStreaming] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  useEffect(() => {
    if (appId !== 'trace') return
    const sid = ui.currentSessionId
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
  }, [appId, ui.currentSessionId])

  // 模型管理应用：增删改查走 IPC，结果 patch 到主进程 store（聊天窗口自动同步）
  const customModels = ui.models.filter((m) => m.custom)
  const handleAddModel = async (input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic' }): Promise<void> => {
    const m = await window.shanhai?.addCustomModel(input)
    if (m) {
      patchUiStore({ models: [...getUiStoreSnapshot().models, m], selectedModel: m.id })
      void window.shanhai?.switchModel(m.id)
    }
  }
  const handleUpdateModel = async (id: string, input: { name: string; baseUrl: string; apiKey: string; model: string; protocol?: 'openai' | 'anthropic' }): Promise<void> => {
    const m = await window.shanhai?.updateCustomModel(id, input)
    if (m) patchUiStore({ models: getUiStoreSnapshot().models.map((x) => (x.id === id ? m : x)) })
  }
  const handleRemoveModel = async (id: string): Promise<void> => {
    await window.shanhai?.removeCustomModel(id)
    patchUiStore({ models: getUiStoreSnapshot().models.filter((m) => m.id !== id) })
  }
  const handleSelectModel = (id: string): void => {
    patchUiStore({ selectedModel: id })
    void window.shanhai?.switchModel(id)
  }

  switch (appId) {
    case 'memory':
      return <MemoryPanel variant="window" onClose={close} />
    case 'settings':
      return <SettingsPanel variant="window" onClose={close} />
    case 'trace':
      return (
        <TracePanel
          variant="window"
          sessionId={ui.currentSessionId}
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
            {manifest?.name ?? appId}
          </header>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            未知应用：{appId}
          </div>
        </div>
      )
  }
}
