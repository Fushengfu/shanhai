import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
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
 * 动态插件窗口内容组件：用 client 半源码 new Function 编译成窗口组件。
 * 契约：function(React, helpers){ return 组件函数 }（helpers = { close, appId, name }），
 * 必须 return 一个 React 组件函数（不能 return 对象 / 箭头函数返回对象）；返回非函数则显示「未提供窗口界面」占位。
 * app 窗口是独立渲染进程，看不到聊天窗口的 SlotRegistry，故经主进程「plugin-app:get」拿 clientCode 后在此编译渲染。
 */
function DynamicPluginWindow({ appId, name, clientCode, onClose }: { appId: string; name: string; clientCode: string; onClose: () => void }): React.JSX.Element {
  const Component = useMemo(() => {
    try {
      const factory = new Function('React', 'helpers', clientCode) as (ReactNs: typeof React, helpers: unknown) => unknown
      const result = factory(React, { close: onClose, appId, name })
      if (typeof result === 'function') return result as React.ComponentType
      return null
    } catch (err) {
      console.error('[plugin-app] 窗口组件编译失败:', err)
      return null
    }
  }, [clientCode, onClose, appId, name])

  if (!Component) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-muted)', fontSize: 13 }}>
        插件「{name}」未提供窗口界面（client 半需返回 React 组件）
      </div>
    )
  }
  return <Component />
}

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
    patchUiStore({ models: getUiStoreSnapshot().models.filter((m) => m.id !== id) })
  }
  const handleSelectModel = (id: string): void => {
    patchUiStore({ selectedModel: id })
    void window.shanhai?.switchModel(id)
  }

  // 动态插件窗口：查询主进程动态 app 清单（appId = 插件持久化 id，install 时 client 半源码已注册进主进程）
  const [pluginApp, setPluginApp] = useState<{ appId: string; name: string; clientCode: string } | null | undefined>(undefined)
  useEffect(() => {
    let mounted = true
    void window.shanhai?.getPluginApp(appId).then((r) => {
      if (mounted) setPluginApp(r ?? null)
    })
    return () => {
      mounted = false
    }
  }, [appId])

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
      if (pluginApp === undefined) {
        // 查询动态插件 app 中
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-muted)', fontSize: 13 }}>
            加载中…
          </div>
        )
      }
      if (pluginApp) {
        return <DynamicPluginWindow appId={appId} name={pluginApp.name} clientCode={pluginApp.clientCode} onClose={close} />
      }
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
