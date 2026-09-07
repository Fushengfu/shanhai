import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppSettings, AppSettingsPatch, AppUpdateCheckResult, AppUpdateDownloadProgress, GatewayModel, HttpTraceRecord, MobileApkInfo, RemoteStatus, RelayStatus } from '../types'
import { IconActivity, IconGlobe, IconHelp, IconSettings, IconTerminal, IconWrench } from './icons'
import { formatBytes, smallIconBtn } from './ui'
import { WindowTitleBar } from './WindowTitleBar'
// 进度「状态行」文案与全局浮层同源（期5C A 方案：主进程只发 phase，句子在渲染层取词）
import { updateStatusLine } from './UpdateProgressOverlay'
import { LOCALE_DISPLAY_NAME } from '../../shared/i18n'
import { localeOptionOf, useI18n, useLocaleSync } from '../locale'
// tKey：httpTraces.map((t, i) => …) 的循环变量叫 t，会在该回调里遮蔽取词函数 →
// 那几处一律用别名 tKey（同一个函数，只是不被遮蔽）。
import { t, t as tKey } from '../../shared/i18n'

/** 单个开关项：标签 + 描述 + 切换开关 */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  // 本组件渲染期直接取词（开关 tooltip）→ 必须自订阅（期2/期3「谁取词谁订阅」）
  useLocaleSync()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{description}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        title={checked ? t('settings.toggleOn') : t('settings.toggleOff')}
        style={{
          flexShrink: 0,
          width: 40,
          height: 22,
          borderRadius: 11,
          border: 'none',
          cursor: 'pointer',
          position: 'relative',
          background: checked ? 'var(--purple)' : 'var(--border-strong)',
          transition: 'background 0.18s ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'var(--bg-panel)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            transition: 'left 0.18s ease',
          }}
        />
      </button>
    </div>
  )
}

/** 单选组：标签 + 描述 + 多个选项卡片（用于插入/队列模式等互斥配置） */
function RadioGroup({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string
  description: string
  value: string
  options: Array<{ value: string; label: string; desc: string }>
  onChange: (v: string) => void
}) {
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{description}</div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {options.map((o) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              role="radio"
              aria-checked={active}
              style={{
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: 8,
                border: active ? '1px solid var(--purple)' : '1px solid var(--border-soft)',
                background: active ? 'var(--tint-purple)' : 'var(--bg-panel)',
                cursor: 'pointer',
                transition: 'border-color 0.15s ease, background 0.15s ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    border: active ? '4px solid var(--purple)' : '2px solid var(--border-strong)',
                    boxSizing: 'border-box',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{o.label}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{o.desc}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 区块标题：左侧竖线 + 大写小字，统一了原本重复的内联样式 */
function SectionTitle({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        margin: first ? '2px 0 8px' : '18px 0 6px',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        borderLeft: '3px solid var(--accent)',
        paddingLeft: 8,
      }}
    >
      {children}
    </div>
  )
}

/** 设置面板侧边栏分组定义 */
type SectionId = 'general' | 'model' | 'connection' | 'debug' | 'about'

// 表里只存词条键，标签渲染时取词 —— 直接存中文会让侧边栏分组名在模块加载期固化，
// 切语言不跟着变（期1 STATUS_LABEL / 期2 TOOL_META / 期3 SUPERVISOR_ARG_LABELS 三次实证过的坑）。
const SECTIONS: Array<{ id: SectionId; k: string; icon: ReactNode }> = [
  { id: 'general', k: 'settings.section.general', icon: <IconWrench /> },
  { id: 'model', k: 'settings.section.model', icon: <IconActivity /> },
  { id: 'connection', k: 'settings.section.connection', icon: <IconGlobe /> },
  { id: 'debug', k: 'settings.section.debug', icon: <IconTerminal /> },
  { id: 'about', k: 'settings.section.about', icon: <IconHelp /> },
]

/** 设置面板：左侧分组导航 + 右侧内容区，配置通用设置（浏览器窗口显示等），持久化到 config.json，跨会话、重启保留。侧滑铺满主区域 */
export function SettingsPanel({ left, top, onClose, variant = 'panel' }: { left?: number; top?: number; onClose?: () => void; variant?: 'panel' | 'window' }) {
  // 当前生效语言（用于「当前生效」那一行；本面板自身的文案属第 4 期，本期不翻）
  const { locale, switchLocale } = useI18n()
  const [settings, setSettings] = useState<AppSettings>({ browser: { showOnCreate: true, enableWebBridge: false }, messageSubmit: { mode: 'queue' }, debug: { traceLlm: false }, voice: { enabled: false }, supervisorApproval: { enabled: true }, supervisorAsk: { enabled: true }, compaction: { modelId: '' }, locale: '', dmAutoReply: false, dmReplyMode: 'assistant' })
  const [models, setModels] = useState<GatewayModel[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [httpTraces, setHttpTraces] = useState<HttpTraceRecord[]>([])
  const [showHttpTraces, setShowHttpTraces] = useState(false)
  const [dsb, setDsb] = useState<{ windowReady: boolean; bridgeInjected: boolean }>({ windowReady: false, bridgeInjected: false })
  const [dsbBusy, setDsbBusy] = useState(false)
  const [dsbMsg, setDsbMsg] = useState('')
  const [dsbMsgOk, setDsbMsgOk] = useState(true)
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [relay, setRelay] = useState<RelayStatus | null>(null)
  const [version, setVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<AppUpdateCheckResult | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  // 安装包下载进度（主进程广播 app:update-download-progress）：在「关于山海」区就地显示进度条
  const [updateProgress, setUpdateProgress] = useState<AppUpdateDownloadProgress | null>(null)
  const [mobileApk, setMobileApk] = useState<MobileApkInfo | null>(null)
  const [mobileLoading, setMobileLoading] = useState(false)
  const [mobileError, setMobileError] = useState('')
  const [activeSection, setActiveSection] = useState<SectionId>('general')

  const loadDsb = useCallback(() => {
    void window.shanhai
      ?.getDeepSeekBridgeStatus()
      .then((s) => {
        if (s) setDsb(s)
      })
      .catch(() => undefined)
  }, [])

  const loadRemote = useCallback(() => {
    void window.shanhai
      ?.remoteStatus()
      .then((s) => {
        if (s) setRemote(s)
      })
      .catch(() => undefined)
  }, [])

  const refreshRemoteCode = useCallback(async () => {
    setRefreshBusy(true)
    try {
      const s = await window.shanhai?.refreshRemoteCode()
      if (s) setRemote(s)
    } catch (e) {
      console.error('[remote] 刷新配对码失败:', e)
    } finally {
      setRefreshBusy(false)
    }
  }, [])

  const loadRelay = useCallback(() => {
    void window.shanhai
      ?.relayStatus()
      .then((s) => {
        if (s) setRelay(s)
      })
      .catch(() => undefined)
  }, [])

  const openDsb = useCallback(async () => {
    setDsbBusy(true)
    setDsbMsg('')
    try {
      const r = await window.shanhai?.openDeepSeekBridge()
      setDsbMsg(r?.message ?? '')
      setDsbMsgOk(!!r?.ok)
      loadDsb()
    } catch (e) {
      setDsbMsg(e instanceof Error ? e.message : String(e))
      setDsbMsgOk(false)
    } finally {
      setDsbBusy(false)
    }
  }, [loadDsb])

  const injectDsb = useCallback(async () => {
    setDsbBusy(true)
    setDsbMsg('')
    try {
      const r = await window.shanhai?.injectDeepSeekBridge()
      setDsbMsg(r?.message ?? '')
      setDsbMsgOk(!!r?.ok)
      loadDsb()
    } catch (e) {
      setDsbMsg(e instanceof Error ? e.message : String(e))
      setDsbMsgOk(false)
    } finally {
      setDsbBusy(false)
    }
  }, [loadDsb])

  const loadHttpTraces = useCallback(() => {
    void window.shanhai?.getHttpTrace().then((t) => setHttpTraces(t ?? [])).catch(() => setHttpTraces([]))
  }, [])

  const load = useCallback(() => {
    void window.shanhai
      ?.getSettings()
      .then((s) => {
        if (s) setSettings(s)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
    void window.shanhai?.listModels().then((m) => setModels(m ?? [])).catch(() => setModels([]))
  }, [])

  const loadUpdate = useCallback(() => {
    void window.shanhai
      ?.getVersion()
      .then((v) => {
        if (v) setVersion(v)
      })
      .catch(() => undefined)
    void window.shanhai
      ?.getUpdateStatus()
      .then((s) => setUpdateStatus(s ?? null))
      .catch(() => undefined)
  }, [])

  const checkUpdate = useCallback(async () => {
    if (updateChecking) return
    setUpdateChecking(true)
    try {
      const r = await window.shanhai?.checkUpdate()
      if (r) setUpdateStatus(r)
    } catch (e) {
      console.error('[update] 检查更新失败:', e)
    } finally {
      setUpdateChecking(false)
    }
  }, [updateChecking])

  // 拉取手机端（Android）APK 下载信息，用于「下载手机端」入口的二维码与下载链接
  const loadMobileApk = useCallback(async () => {
    if (mobileLoading) return
    setMobileLoading(true)
    setMobileError('')
    setMobileApk(null)
    try {
      const info = await window.shanhai?.getMobileApkInfo('com.amulet.shanhai')
      if (info?.downloadUrl) setMobileApk(info)
      else setMobileError(t('settings.mobile.noVersion'))
    } catch (e) {
      setMobileError(e instanceof Error ? e.message : String(e))
    } finally {
      setMobileLoading(false)
    }
  }, [mobileLoading])

  useEffect(() => {
    load()
    loadDsb()
    loadRemote()
    loadRelay()
    loadUpdate()
  }, [load, loadDsb, loadRemote, loadRelay, loadUpdate])

  useEffect(() => {
    const unsub = window.shanhai?.onUpdateAvailable((result) => {
      setUpdateStatus(result)
    })
    return () => unsub?.()
  }, [])

  // 订阅网关中继状态实时推送：401 凭证失效（连网关被拒）时能实时感知，而不是只在打开设置时被动查一次
  useEffect(() => {
    const unsub = window.shanhai?.onRelayStatus((status) => {
      setRelay(status)
    })
    return () => unsub?.()
  }, [])

  // 订阅安装包下载进度：在「关于山海」就地显示进度条；终态（完成/失败/取消）保留展示，不卡在 99%
  useEffect(() => {
    void window.shanhai
      ?.getUpdateDownloadProgress()
      .then((p) => {
        if (p) setUpdateProgress(p)
      })
      .catch(() => undefined)
    const unsub = window.shanhai?.onUpdateDownloadProgress((p) => {
      setUpdateProgress(p)
    })
    return () => unsub?.()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const update = useCallback(
    async (patch: AppSettingsPatch): Promise<void> => {
      setSaving(true)
      try {
        const next = await window.shanhai?.setSettings(patch)
        if (next) setSettings(next)
      } catch {
        // 忽略保存失败，保留本地状态
      } finally {
        setSaving(false)
      }
    },
    [],
  )

  // 语言切换的失败原因（可见呈现，不静默）
  const [localeError, setLocaleError] = useState('')
  const onLocaleChange = useCallback(async (v: string): Promise<void> => {
    setLocaleError('')
    try {
      // 'auto' 走 update() 写回空串（跟随系统）；具体语言走 switchLocale（乐观应用 + 失败抛错）
      // 两条分支都必须把落盘回来的 locale 同步进面板 state —— 单选组的高亮判的就是 settings.locale。
      // 历轮 switchLocale 的返回值被丢弃 → 界面语言切了、高亮却还停在 mount 时读到的旧值（用户报的 bug）。
      if (v === 'auto') { await update({ locale: '' }); return }
      const next = await switchLocale(v as 'zh-CN' | 'en-US')
      if (next && typeof next.locale === 'string') setSettings((prev) => ({ ...prev, locale: next.locale }))
    } catch (e) {
      setLocaleError(t('settings.lang.saveFailed', { err: e instanceof Error ? e.message : String(e) }))
    }
  }, [update, switchLocale])

  return (
    <div
      style={{
        ...(variant === 'window'
          ? { height: '100vh' }
          : { position: 'fixed', top, left, right: 0, bottom: 0, zIndex: 50, borderLeft: '1px solid var(--border)', boxShadow: '-20px 0 60px rgba(0,0,0,0.2)' }),
        background: 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <WindowTitleBar
        icon={<IconSettings />}
        title={t('settings.title')}
        subtitle={saving ? t('common.saving') : t('settings.subtitleAutoSave')}
        onClose={() => onClose?.()}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* 左侧分组导航 */}
        <nav
          style={{
            width: 176,
            flexShrink: 0,
            borderRight: '1px solid var(--border)',
            padding: '12px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            overflowY: 'auto',
            background: 'var(--bg-sidebar)',
          }}
        >
          {SECTIONS.map((s) => {
            const active = activeSection === s.id
            return (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: 'none',
                  background: active ? 'var(--tint-purple)' : 'transparent',
                  color: active ? 'var(--purple)' : 'var(--text-secondary)',
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}
              >
                <span style={{ display: 'inline-flex', width: 16, height: 16, flexShrink: 0, color: active ? 'var(--purple)' : 'var(--text-muted)' }}>{s.icon}</span>
                <span>{t(s.k)}</span>
              </button>
            )
          })}
        </nav>

        {/* 右侧内容区 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 40px' }}>
          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>{t('common.loading')}</div>
          ) : (
            <>
              {activeSection === 'general' && (
                <>
                  {/*
                    【i18n 期1】界面语言开关放在「通用」分区最前面：
                    - 这是本期唯一的语言切换入口（用户拍板：切换入口放设置面板，不放顶栏）；
                    - 选项里的「简体中文 / English」用各自语言书写（LOCALE_DISPLAY_NAME 是常量、故意不进语言包），
                      否则英文用户在一个还没翻译的设置面板里找不到哪个是 English；
                    - 选「跟随系统」= 把真相源写回空串，下次启动重新按系统语言解析。
                    期1 因为本面板其余文案未翻，这里临时做了「中英并列」；本期（期4A）面板文案已抽干，
                    过渡态清掉，标题与说明一律走 t()。
                    选项里的「简体中文 / English」仍用各自语言书写（LOCALE_DISPLAY_NAME 是常量、故意不进语言包）：
                    语言自称名必须用本语言显示，否则英文用户认不出哪个是 English。
                  */}
                  <SectionTitle first>{t('settings.lang.section')}</SectionTitle>
                  <RadioGroup
                    label={t('settings.lang.label')}
                    description={t('settings.lang.desc')}
                    value={localeOptionOf(settings.locale)}
                    onChange={(v) => void onLocaleChange(v)}
                    options={[
                      { value: 'auto', label: t('settings.lang.auto'), desc: t('settings.lang.autoDesc') },
                      { value: 'zh-CN', label: LOCALE_DISPLAY_NAME['zh-CN'], desc: t('settings.lang.zhDesc') },
                      { value: 'en-US', label: LOCALE_DISPLAY_NAME['en-US'], desc: t('settings.lang.enDesc') },
                    ]}
                  />
                  <div style={{ padding: '0 0 4px', fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('settings.lang.current', { v: LOCALE_DISPLAY_NAME[locale] })}
                  </div>
                  {/*
                    切换失败必须可见：本面板原有的 update() 是 `catch { 忽略保存失败 }`（既有行为，本期不动其它设置项），
                    但语言这一项如果写失败 = 用户以为切了、下次启动又变回去，属本项目红线级的静默失败，
                    所以这里单独走 switchLocale，把失败原因显示在开关下方。
                  */}
                  {localeError && (
                    <div style={{ margin: '0 0 8px', padding: '6px 9px', borderRadius: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--danger-text, #b91c1c)', background: 'var(--tint-red, rgba(239,68,68,0.08))', border: '1px solid var(--border-soft)' }}>
                      {localeError}
                    </div>
                  )}
                  <SectionTitle>{t('settings.browser.section')}</SectionTitle>
                  <ToggleRow
                    label={t('settings.browser.showOnCreate')}
                    description={t('settings.browser.showOnCreateDesc')}
                    checked={settings.browser.showOnCreate}
                    onChange={(v) => void update({ browser: { showOnCreate: v } })}
                  />
                  <SectionTitle>{t('settings.message.section')}</SectionTitle>
                  <RadioGroup
                    label={t('settings.submit.label')}
                    description={t('settings.submit.desc')}
                    value={settings.messageSubmit.mode}
                    onChange={(v) => void update({ messageSubmit: { mode: v as 'queue' | 'insert' } })}
                    options={[
                      { value: 'queue', label: t('settings.submit.queue'), desc: t('settings.submit.queueDesc') },
                      { value: 'insert', label: t('settings.submit.insert'), desc: t('settings.submit.insertDesc') },
                    ]}
                  />
                  <SectionTitle>{t('settings.voice.section')}</SectionTitle>
                  <ToggleRow
                    label={t('settings.voice.label')}
                    description={t('settings.voice.desc')}
                    checked={settings.voice.enabled}
                    onChange={(v) => void update({ voice: { enabled: v } })}
                  />
                  <SectionTitle>{t('settings.sup.section')}</SectionTitle>
                  <ToggleRow
                    label={t('settings.supApproval.label')}
                    description={t('settings.supApproval.desc')}
                    checked={settings.supervisorApproval.enabled}
                    onChange={(v) => void update({ supervisorApproval: { enabled: v } })}
                  />
                  <ToggleRow
                    label={t('settings.supAsk.label')}
                    description={t('settings.supAsk.desc')}
                    checked={settings.supervisorAsk.enabled}
                    onChange={(v) => void update({ supervisorAsk: { enabled: v } })}
                  />
                </>
              )}

              {activeSection === 'model' && (
                <>
                  <SectionTitle first>{t('settings.compaction.section')}</SectionTitle>
                  <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t('settings.compaction.model')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>
                      {t('settings.compaction.modelDesc')}
                    </div>
                    <select
                      value={settings.compaction?.modelId ?? ''}
                      onChange={(e) => void update({ compaction: { modelId: e.target.value } })}
                      style={{ marginTop: 8, width: '100%', padding: '6px 8px', fontSize: 13, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text)' }}
                    >
                      <option value="">{t('settings.compaction.follow')}</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {t('settings.modelOptionLine', { name: m.name, id: m.id })}
                        </option>
                      ))}
                    </select>
                  </div>
                  <SectionTitle>{t('settings.dsb.section')}</SectionTitle>
                  <ToggleRow
                    label={t('settings.dsb.enable')}
                    description={t('settings.dsb.enableDesc')}
                    checked={settings.browser.enableWebBridge}
                    onChange={(v) => void update({ browser: { enableWebBridge: v } })}
                  />
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: '4px 0 8px' }}>
                    {t('settings.dsb.hint')}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span>{t('settings.dsb.window', { v: dsb.windowReady ? t('settings.dsb.windowReady') : t('settings.dsb.windowNot') })}</span>
                    <span>{t('settings.dsb.bridge', { v: dsb.bridgeInjected ? t('settings.dsb.injected') : t('settings.dsb.notInjected') })}</span>
                  </div>
                  <div style={{ padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => void openDsb()}
                      disabled={dsbBusy}
                      style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                    >
                      {dsbBusy ? t('settings.dsb.busy') : t('settings.dsb.openInject')}
                    </button>
                    <button
                      onClick={() => void injectDsb()}
                      disabled={dsbBusy}
                      style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                    >
                      {t('settings.dsb.reinject')}
                    </button>
                  </div>
                  {dsbMsg ? (
                    <div style={{ fontSize: 12, color: dsbMsgOk ? 'var(--success-text)' : 'var(--danger-text)', margin: '2px 0 8px', lineHeight: 1.5, wordBreak: 'break-all' }}>
                      {dsbMsg}
                    </div>
                  ) : null}
                </>
              )}

              {activeSection === 'connection' && (
                <>
                  <SectionTitle first>{t('settings.remote.section')}</SectionTitle>
                  <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t('settings.remote.lan')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>
                      {t('settings.remote.lanDesc')}
                    </div>
                  </div>
                  {remote?.enabled ? (
                    <div style={{ padding: '8px 0', fontSize: 12, lineHeight: 1.9, color: 'var(--text-secondary)' }}>
                      <div>
                        {t('settings.remote.ipLabel')}<span style={{ fontWeight: 600, color: 'var(--text)' }}>{remote.ip}:{remote.port}</span>
                      </div>
                      <div>
                        {t('settings.remote.codeLabel')}<span style={{ fontWeight: 700, fontSize: 16, letterSpacing: 3, color: 'var(--purple)' }}>{remote.pairingCode}</span>
                      </div>
                      <div style={{ color: 'var(--text-muted)' }}>{t('settings.remote.paired', { n: remote.pairedClients })}</div>
                      <div style={{ color: 'var(--text-faint)' }}>{t('settings.remote.hint')}</div>
                      <button
                        onClick={() => {
                          if (!refreshBusy) void refreshRemoteCode()
                        }}
                        disabled={refreshBusy}
                        style={{ ...smallIconBtn, marginTop: 8, padding: '4px 12px', fontSize: 12 }}
                      >
                        {refreshBusy ? t('settings.remote.refreshing') : t('settings.remote.refreshCode')}
                      </button>
                    </div>
                  ) : (
                    <div style={{ padding: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.remote.disabled')}</div>
                  )}
                  <SectionTitle>{t('settings.relay.section')}</SectionTitle>
                  <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t('settings.relay.title')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>
                      {t('settings.relay.desc')}
                    </div>
                  </div>
                  {relay?.enabled ? (
                    <div style={{ padding: '8px 0', fontSize: 12, lineHeight: 1.9, color: 'var(--text-secondary)' }}>
                      <div>
                        {t('settings.relay.statusLabel')}<span style={{ fontWeight: 600, color: relay.connected ? 'var(--success-text)' : relay.authFailed ? 'var(--danger-text)' : 'var(--danger-text)' }}>{relay.connected ? t('settings.relay.connected') : relay.authFailed ? t('settings.relay.authFailed') : t('settings.relay.notConnected')}</span>
                      </div>
                      <div>{t('settings.relay.account', { u: relay.username ?? t('common.notLoggedIn') })}</div>
                      <div>{t('settings.relay.clients', { n: relay.clientCount })}</div>
                      {relay.error ? (
                        <div
                          style={{
                            marginTop: 6,
                            padding: '8px 10px',
                            borderRadius: 6,
                            fontSize: 12,
                            lineHeight: 1.5,
                            color: relay.authFailed ? 'var(--danger-text)' : 'var(--text)',
                            background: relay.authFailed ? 'var(--tint-red, rgba(239,68,68,0.12))' : 'var(--tint-orange, rgba(245,158,11,0.12))',
                          }}
                        >
                          {relay.error}
                        </div>
                      ) : null}
                      <div style={{ color: 'var(--text-faint)' }}>{t('settings.relay.hint')}</div>
                    </div>
                  ) : (
                    <div style={{ padding: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.remote.disabled')}</div>
                  )}
                </>
              )}

              {activeSection === 'debug' && (
                <>
                  <SectionTitle first>{t('settings.debug.section')}</SectionTitle>
                  <ToggleRow
                    label={t('settings.trace.label')}
                    description={t('settings.trace.desc')}
                    checked={settings.debug.traceLlm}
                    onChange={(v) => void update({ debug: { traceLlm: v } })}
                  />
                  <div style={{ padding: '10px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      onClick={() => {
                        setShowHttpTraces((s) => !s)
                        if (!showHttpTraces) loadHttpTraces()
                      }}
                      style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                    >
                      {showHttpTraces ? t('settings.trace.collapse') : t('settings.trace.expand')}
                    </button>
                    <button
                      onClick={() => {
                        void window.shanhai?.clearHttpTrace().then(() => setHttpTraces([]))
                      }}
                      style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                    >
                      {t('settings.trace.clearAll')}
                    </button>
                    <button
                      onClick={() => {
                        void window.shanhai?.openTraceDir()
                      }}
                      style={{ ...smallIconBtn, padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                    >
                      {t('settings.trace.openDir')}
                    </button>
                  </div>
                  {showHttpTraces && (
                    <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginTop: 4 }}>
                      {httpTraces.length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--text-faint)', textAlign: 'center', padding: 16 }}>{t('settings.trace.empty')}</div>
                      ) : (
                        httpTraces.map((t, i) => (
                          <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-secondary)' }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              <span style={{ color: 'var(--text-muted)' }}>#{i + 1}</span>
                              <span style={{ fontWeight: 600, color: t.phase === 'request' ? 'var(--accent)' : 'var(--success-text)' }}>{t.phase === 'request' ? tKey('settings.trace.request') : tKey('settings.trace.response')}</span>
                              <span style={{ color: 'var(--text-muted)' }}>{new Date(t.ts).toLocaleTimeString()}</span>
                              {t.responseStatus != null && <span style={{ color: 'var(--text-muted)' }}>HTTP {t.responseStatus}</span>}
                              {t.error ? <span style={{ color: 'var(--danger-text)' }}>{tKey('settings.trace.errorTag')}</span> : null}
                            </div>
                            <div style={{ color: 'var(--text-muted)', fontSize: 11, wordBreak: 'break-all', marginTop: 2 }}>{t.method} {t.url}</div>
                            {t.error ? (
                              <div style={{ color: 'var(--danger-text)', marginTop: 2, wordBreak: 'break-all' }}>{t.error}</div>
                            ) : (
                              <details style={{ marginTop: 2 }}>
                                <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11 }}>{tKey('settings.trace.fullBody')}</summary>
                                <pre style={{ margin: '4px 0 0', padding: 6, background: 'var(--bg-sidebar)', borderRadius: 4, overflowX: 'auto', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                  {typeof t.body === 'string' ? t.body : JSON.stringify(t.body ?? null, null, 2)}
                                </pre>
                              </details>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}

              {activeSection === 'about' && (
                <>
                  <SectionTitle first>{t('settings.about.section')}</SectionTitle>
                  <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {t('settings.about.currentVersion')} <span style={{ color: 'var(--purple)' }}>v{version || '—'}</span>
                    </div>
                    {/* updateStatus.message 是主进程/网关返回的原文：按口径④不做客户端全量映射，原样呈现 */}
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                      {updateStatus?.hasUpdate
                        ? t('settings.about.newVersion', { v: updateStatus.latestVersion ?? '' })
                        : updateStatus
                          ? (updateStatus.message ?? (updateStatus.success ? t('settings.about.isLatest') : t('settings.about.checkFailed')))
                          : t('settings.about.clickToCheck')}
                    </div>
                    {updateStatus?.releaseNotes ? (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {updateStatus.releaseNotes}
                      </div>
                    ) : null}
                    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        onClick={() => void checkUpdate()}
                        disabled={updateChecking}
                        style={{ ...smallIconBtn, padding: '4px 12px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                      >
                        {updateChecking ? t('settings.about.checking') : t('settings.about.checkUpdate')}
                      </button>
                      <button
                        onClick={() => void loadMobileApk()}
                        disabled={mobileLoading}
                        style={{ ...smallIconBtn, padding: '4px 12px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                      >
                        {mobileLoading ? t('settings.about.fetching') : t('settings.about.downloadMobile')}
                      </button>
                      {updateStatus?.checkedAt ? (
                        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                          {t('settings.about.lastCheck', { t: new Date(updateStatus.checkedAt).toLocaleString() })}
                        </span>
                      ) : null}
                    </div>

                    {/* 安装包下载进度（主进程广播 app:update-download-progress，全局浮层之外的就地反馈）
                        终态里 completed/cancelled 只在 30s 内就地展示（避免长期挂着一块过期卡片）；
                        failed 一直保留到用户重新检查/关闭窗口，确保能看到失败原因 */}
                    {updateProgress &&
                    (updateProgress.phase === 'failed' ||
                      !(updateProgress.phase === 'completed' || updateProgress.phase === 'cancelled') ||
                      Date.now() - updateProgress.updatedAt < 30_000) ? (
                      <div
                        style={{
                          marginTop: 10,
                          padding: '10px 12px',
                          borderRadius: 8,
                          border: `1px solid ${updateProgress.phase === 'failed' ? 'var(--tint-red-strong)' : 'var(--border-soft)'}`,
                          background: 'var(--bg-sidebar)',
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                          {updateProgress.phase === 'pending' && t('settings.upd.pending')}
                          {updateProgress.phase === 'downloading' &&
                            (updateProgress.latestVersion
                              ? t('settings.upd.downloadingV', { v: updateProgress.latestVersion })
                              : t('panels.updDownloading'))}
                          {updateProgress.phase === 'verifying' && t('settings.upd.verifying')}
                          {updateProgress.phase === 'completed' && t('settings.upd.completed')}
                          {updateProgress.phase === 'failed' && t('panels.updFailed')}
                          {updateProgress.phase === 'cancelled' && t('panels.updCancelled')}
                        </div>
                        <div style={{ marginTop: 8, height: 6, borderRadius: 999, background: 'var(--bg-panel)', overflow: 'hidden' }}>
                          <div
                            style={{
                              height: '100%',
                              width: updateProgress.percent >= 0 ? `${Math.min(100, Math.max(0, updateProgress.percent))}%` : '40%',
                              borderRadius: 999,
                              background: updateProgress.phase === 'failed' ? 'var(--danger-text)' : 'var(--accent)',
                              transition: 'width 240ms ease',
                            }}
                          />
                        </div>
                        <div style={{ marginTop: 6, display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                          <span>{updateProgress.percent >= 0 ? `${updateProgress.percent.toFixed(1)}%` : t('settings.upd.progressUnknown')}</span>
                          <span>
                            {formatBytes(updateProgress.receivedBytes)}
                            {updateProgress.totalBytes > 0 ? ` / ${formatBytes(updateProgress.totalBytes)}` : ''}
                          </span>
                          {updateProgress.bytesPerSecond > 0 ? <span>{formatBytes(updateProgress.bytesPerSecond)}/s</span> : null}
                          {updateProgress.fileName ? <span style={{ color: 'var(--text-faint)' }}>{updateProgress.fileName}</span> : null}
                        </div>
                        {updateStatusLine(updateProgress) ? (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 11,
                              lineHeight: 1.5,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              color: updateProgress.phase === 'failed' ? 'var(--danger-text)' : 'var(--text-secondary)',
                            }}
                          >
                            {updateStatusLine(updateProgress)}
                          </div>
                        ) : null}
                        {updateProgress.phase === 'downloading' || updateProgress.phase === 'pending' ? (
                          <button
                            onClick={() => void window.shanhai?.cancelUpdateDownload().catch(() => undefined)}
                            style={{ ...smallIconBtn, marginTop: 8, padding: '4px 12px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 6 }}
                          >
                            {t('panels.updCancelDownload')}
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {/* 手机端下载：二维码 + 下载链接 */}
                    {mobileError ? (
                      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--danger-text)' }}>{mobileError}</div>
                    ) : null}
                    {mobileApk ? (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
                        <img
                          src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(mobileApk.downloadUrl)}`}
                          alt={t('settings.apk.qrAlt')}
                          width={160}
                          height={160}
                          style={{ borderRadius: 8, border: '1px solid var(--border-soft)' }}
                        />
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                          {mobileApk.version ? t('settings.apk.scanHintV', { v: mobileApk.version }) : t('settings.apk.scanHint')}
                        </div>
                        <a
                          href={mobileApk.downloadUrl}
                          download="shanhai-android.apk"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-soft)', background: 'var(--accent)', color: '#fff', fontSize: 12, textDecoration: 'none', cursor: 'pointer' }}
                        >
                          {t('settings.apk.download')}
                        </a>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
