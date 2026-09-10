/**
 * 技能市场（已安装 / 市场两个 tab：第三方技能搜索 / 详情审计 / 安装）。
 *
 * 【入口】账号悬停弹窗（AccountPopover）的「技能」区 → 「去技能市场」→ openApp('skills-market')。
 * 与记忆/轨迹一样是二级入口应用（registry 里 showInDock:false），不占 Dock 图标位。
 *
 * 【卡片视觉基线 = 插件市场】结果与已安装列表都是**卡片网格**，数值全部取自
 * components/marketCards.tsx（该文件逐值提取自 PluginMarketApp 的 MarketCard / MyCard /
 * Tag / AppIcon / FilterChip / SkeletonCard），不再自创一套。tab 条同样取自该文件。
 *
 * 【安全（本界面是安装闸门的一部分，不是装饰）】
 *  - 详情区**必须**把审计结果显示出来：风险等级 + 全部 warnings + requiresBins/requiresEnv（含本机缺失项）；
 *  - 高风险（high/critical）技能的安装按钮必须**二次确认**（第一次点变成「确认安装」，再点才真装）；
 *    主进程侧还有第二道闸门（不传 confirmRisk 时**不下载任何字节**）—— 界面按钮只是第一道；
 *  - SKILL.md 一律以纯文本渲染（<pre>），绝不 dangerouslySetInnerHTML（第三方内容）；
 *  - 安装进度与结果（成功/失败）都必须可见 —— 禁止「点了什么都不发生」。
 *
 * 【数据】全部经 preload 桥走主进程（main/skills-market.ts 与 main/skills-mcp.ts）：
 * 渲染层拿不到 URL、不直连公网、不碰文件系统。
 */
import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillInstallProgress, SkillMarketItem, SkillMarketSource, SkillPreview } from '../../shared/skills-market'
import type { SkillSummary } from '../../shared/account-services'
import { WindowTitleBar } from '../components/WindowTitleBar'
import { IconSearch, IconStore, IconWarn, IconWrench, IconClose, IconRefresh } from '../components/icons'
import { btn, smallIconBtn } from '../components/ui'
import {
  MarketCardButton,
  MarketCardHead,
  MarketCardShell,
  MarketEmpty,
  MarketFilterChip,
  MarketMetaRow,
  MarketSkeletonCard,
  MarketTabBar,
  MarketTag,
  MarketTagRow,
  MARKET_GRID_STYLE,
} from '../components/marketCards'
import { t } from '../../shared/i18n'
import { useLocaleSync } from '../locale'
import { useThemeSync } from '../theme'

/** 分类（与主进程 CATEGORY_TO_SKILLHUB_KEY 的 key 一一对应；仅 skillhub 支持分类过滤） */
const CATEGORIES = ['office', 'content', 'dev', 'data', 'design', 'ai-agent', 'knowledge', 'business', 'edu', 'pro', 'itops', 'life'] as const

/** 风险等级 → 配色（全部用既有 CSS 变量，不新造色值） */
const RISK_COLOR: Record<SkillPreview['riskLevel'], string> = {
  low: 'var(--success)',
  medium: 'var(--warning)',
  high: 'var(--danger)',
  critical: 'var(--danger)',
}

const RISK_TINT: Record<SkillPreview['riskLevel'], string> = {
  low: 'var(--tint-green)',
  medium: 'var(--tint-orange)',
  high: 'var(--tint-red)',
  critical: 'var(--tint-red)',
}

/** 安装阶段 → 文案 key（进度反馈） */
const STAGE_KEY: Record<SkillInstallProgress['stage'], string> = {
  download: 'skills.market.stage.download',
  verify: 'skills.market.stage.verify',
  extract: 'skills.market.stage.extract',
  audit: 'skills.market.stage.audit',
  commit: 'skills.market.stage.commit',
}

function riskLabel(level: SkillPreview['riskLevel']): string {
  switch (level) {
    case 'low':
      return t('skills.market.riskLow')
    case 'medium':
      return t('skills.market.riskMedium')
    case 'high':
      return t('skills.market.riskHigh')
    default:
      return t('skills.market.riskCritical')
  }
}

type TabKey = 'installed' | 'market'

export function SkillMarketApp({ onClose }: { onClose: () => void }): React.JSX.Element {
  useLocaleSync()
  useThemeSync()

  /** 默认落在「已安装」（用户先说已安装；入口本来就在「我装了什么」的语境里） */
  const [tab, setTab] = useState<TabKey>('installed')

  // ——— 已安装（本机 ~/.shanhai/skills + 内置）———
  const [skills, setSkills] = useState<SkillSummary[] | null>(null)
  const [skillsErr, setSkillsErr] = useState<string | null>(null)

  // ——— 市场 ———
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | SkillMarketSource>('all')
  const [category, setCategory] = useState<string>('')
  const [items, setItems] = useState<SkillMarketItem[]>([])
  const [total, setTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  const [selected, setSelected] = useState<SkillMarketItem | null>(null)
  const [preview, setPreview] = useState<SkillPreview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<SkillInstallProgress | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  // ——— 卸载（「已安装」tab 里对 user 技能）———
  /** 正处于「确认卸载」态的技能 id（先点变「确认卸载」，再点才真删；点「取消」清空） */
  const [confirmUninstall, setConfirmUninstall] = useState<string>('')
  /** 正在卸载的技能 id（防重复点，按钮显示「卸载中…」） */
  const [uninstalling, setUninstalling] = useState<string>('')
  /** 卸载结果反馈（成功/失败都必须可见 —— 禁止「点了什么都不发生」） */
  const [uninstallMsg, setUninstallMsg] = useState<{ ok: boolean; text: string } | null>(null)

  /** 当前正在预览/安装的 slug（异步回来时丢弃过期结果，避免快速点击串台） */
  const activeSlug = useRef<string>('')
  /** 卡片上的「安装到本机」点了之后，等详情+审计回来再走同一套安装流程 */
  const pendingInstall = useRef<string>('')

  const loadInstalled = useCallback(async (): Promise<void> => {
    const sh = window.shanhai
    if (!sh?.listSkills) {
      setSkills([])
      setSkillsErr(t('skills.market.failed'))
      return
    }
    try {
      const r = await sh.listSkills()
      setSkills(r.skills)
      setSkillsErr(r.error ?? null)
    } catch (e) {
      setSkills([])
      setSkillsErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // 打开窗口即读本机技能（默认 tab 就是它）
  useEffect(() => {
    void loadInstalled()
  }, [loadInstalled])

  // 安装进度：主进程只回发给发起安装的那个窗口
  useEffect(() => {
    const off = window.shanhai?.onSkillInstallProgress?.((p) => {
      if (p.slug === activeSlug.current) setProgress(p)
    })
    return off
  }, [])

  // Esc 关闭窗口（与其它窗口应用同口径）
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const runSearch = useCallback(async (): Promise<void> => {
    const sh = window.shanhai
    if (!sh?.searchSkillMarket) {
      setSearchErr(t('skills.market.failed'))
      setItems([])
      return
    }
    setSearching(true)
    setSearchErr(null)
    try {
      const r = await sh.searchSkillMarket(query, source, category || undefined)
      setItems(r.items)
      setTotal(r.total)
      setSearchErr(r.error ?? null)
    } catch (err) {
      setItems([])
      setSearchErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }, [query, source, category])

  const doInstall = useCallback(
    async (withConfirm: boolean): Promise<void> => {
      const sh = window.shanhai
      if (!selected || !sh?.installSkillFromMarket) return
      setInstalling(true)
      setResult(null)
      setProgress(null)
      try {
        const r = await sh.installSkillFromMarket({ source: selected.source, slug: selected.slug, confirmRisk: withConfirm })
        if (r.needConfirm) {
          // 主进程的第二道闸门拦下了：把最新的审计结果换上（脚本审计可能比 SKILL.md 更严），并要求二次确认
          if (r.preview) setPreview(r.preview)
          setConfirming(true)
          setResult({ ok: false, text: t('skills.market.needConfirm') })
          return
        }
        if (r.ok) {
          setConfirming(false)
          setResult({ ok: true, text: t('skills.market.installOk', { id: r.id ?? '', n: r.files?.length ?? 0 }) })
          // 列表里的「已安装」角标
          setItems((prev) => prev.map((it) => (it.slug === selected.slug ? { ...it, installed: true } : it)))
          // ★装完立刻刷新「已安装」tab 的数据源（主进程已 refreshSkills 换掉缓存实例）
          void loadInstalled()
        } else {
          setResult({ ok: false, text: r.error ?? t('skills.market.failed') })
        }
      } catch (err) {
        setResult({ ok: false, text: err instanceof Error ? err.message : String(err) })
      } finally {
        setInstalling(false)
      }
    },
    [selected, loadInstalled],
  )

  const openDetail = useCallback(
    async (item: SkillMarketItem): Promise<void> => {
      activeSlug.current = `${item.source}:${item.slug}`
      setSelected(item)
      setPreview(null)
      setPreviewErr(null)
      setConfirming(false)
      setResult(null)
      setProgress(null)
      const sh = window.shanhai
      if (!sh?.previewSkillMarket) {
        setPreviewErr(t('skills.market.failed'))
        return
      }
      setPreviewLoading(true)
      try {
        const r = await sh.previewSkillMarket(item.source, item.slug)
        if (`${item.source}:${item.slug}` !== activeSlug.current) return
        if ('error' in r) setPreviewErr(r.error)
        else setPreview(r)
      } catch (err) {
        if (`${item.source}:${item.slug}` === activeSlug.current) setPreviewErr(err instanceof Error ? err.message : String(err))
      } finally {
        if (`${item.source}:${item.slug}` === activeSlug.current) setPreviewLoading(false)
      }
    },
    [],
  )

  const highRisk = preview ? preview.riskLevel === 'high' || preview.riskLevel === 'critical' : false

  /** 详情区安装按钮的点击口径（卡片按钮也复用同一套：先出审计、高风险要二次确认） */
  const onInstallClick = useCallback((): void => {
    if (highRisk && !confirming) {
      setConfirming(true)
      setResult({ ok: false, text: t('skills.market.confirmHint') })
      return
    }
    void doInstall(confirming || highRisk)
  }, [highRisk, confirming, doInstall])

  // 卡片上的「安装到本机」：详情与审计回来后自动接着走同一套流程（不绕过任何一道闸门）
  useEffect(() => {
    if (!pendingInstall.current || !preview || previewLoading) return
    const key = `${preview.source}:${preview.slug}`
    if (key !== pendingInstall.current) return
    pendingInstall.current = ''
    if (highRisk) {
      setConfirming(true)
      setResult({ ok: false, text: t('skills.market.confirmHint') })
      return
    }
    void doInstall(false)
  }, [preview, previewLoading, highRisk, doInstall])

  /**
   * 卸载一个**用户技能**（「已安装」tab 卡片上的「卸载」按钮）。
   * 破坏性操作：界面侧先二次确认（先点变「确认卸载」，再点才执行），主进程侧再做四道路径/来源校验。
   * 结果（成功/失败）一律写进 `uninstallMsg` 显示出来 —— 禁止「点了什么都不发生」。
   */
  const doUninstall = useCallback(
    async (s: SkillSummary): Promise<void> => {
      const sh = window.shanhai
      if (!sh?.uninstallSkill) {
        setUninstallMsg({ ok: false, text: t('skills.market.failed') })
        return
      }
      setUninstalling(s.id)
      setUninstallMsg(null)
      try {
        const r = await sh.uninstallSkill(s.id)
        if (r.ok) {
          setUninstallMsg({ ok: true, text: t('skills.market.uninstallOk', { id: r.id ?? s.id }) })
          setConfirmUninstall('')
          // ★删完立刻刷新列表（主进程 uninstallSkill 内部已 refreshSkills 换掉缓存实例）
          await loadInstalled()
        } else {
          setUninstallMsg({ ok: false, text: t('skills.market.uninstallFailed', { msg: r.error ?? '' }) })
        }
      } catch (err) {
        setUninstallMsg({ ok: false, text: t('skills.market.uninstallFailed', { msg: err instanceof Error ? err.message : String(err) }) })
      } finally {
        setUninstalling('')
      }
    },
    [loadInstalled],
  )

  const installedCount = skills?.length ?? 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-app)', color: 'var(--text)' }}>
      <WindowTitleBar
        icon={<IconStore />}
        title={t('app.skillsMarket.name')}
        subtitle={t('app.skillsMarket.desc')}
        extra={
          tab === 'market' && searched ? (
            <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>{t('skills.market.resultCount', { n: items.length, total })}</span>
          ) : null
        }
        onClose={onClose}
      />

      <MarketTabBar<TabKey>
        tabs={[
          { k: 'installed', label: t('skills.market.tab.installed') },
          { k: 'market', label: t('skills.market.tab.market') },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'installed' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {skillsErr ? (
            <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tint-red)', color: 'var(--danger)', fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <IconWarn />
              <span style={{ wordBreak: 'break-word' }}>{t('skills.market.searchFailed', { msg: skillsErr })}</span>
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>{!skills ? t('skills.market.loading') : t('skills.market.installedCount', { n: installedCount })}</span>
            <button onClick={() => setTab('market')} style={{ ...btn('var(--accent)', '#fff'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <IconStore />
              {t('skills.market.goMarket')}
            </button>
          </div>
          {/* 卸载结果反馈：成功 / 失败都必须可见（禁止「点了什么都不发生」） */}
          {uninstallMsg ? (
            <div style={{ fontSize: 12, lineHeight: 1.6, wordBreak: 'break-word', color: uninstallMsg.ok ? 'var(--success)' : 'var(--danger)' }}>{uninstallMsg.text}</div>
          ) : null}
          {!skills ? (
            <div style={MARKET_GRID_STYLE}>
              {[0, 1, 2].map((i) => (
                <MarketSkeletonCard key={i} />
              ))}
            </div>
          ) : installedCount === 0 ? (
            <MarketEmpty
              icon={<IconWrench />}
              title={t('skills.market.installedEmpty')}
              hint={t('skills.market.installedEmptyHint')}
              action={
                <button onClick={() => setTab('market')} style={{ ...btn('var(--accent)', '#fff'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <IconStore />
                  {t('skills.market.goMarket')}
                </button>
              }
            />
          ) : (
            <div style={MARKET_GRID_STYLE}>
              {skills.map((s) => (
                <MarketCardShell
                  key={s.id}
                  footer={
                    s.source === 'user' ? (
                      // 第三方（用户装到 ~/.shanhai/skills 的）技能：可卸载。
                      // 二次确认沿用技能市场既有的「先点变确认、再点才执行」写法
                      // （与详情区安装高风险技能同口径：确认态用 var(--danger)）。
                      confirmUninstall === s.id ? (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <MarketCardButton label={t('common.cancel')} tone="outline" onClick={() => setConfirmUninstall('')} />
                          <MarketCardButton
                            label={t('skills.market.confirmUninstall')}
                            tone="danger"
                            disabled={uninstalling === s.id}
                            onClick={() => void doUninstall(s)}
                          />
                        </div>
                      ) : (
                        <MarketCardButton
                          label={uninstalling === s.id ? t('skills.market.uninstalling') : t('skills.market.uninstall')}
                          tone="outline"
                          disabled={uninstalling === s.id}
                          onClick={() => {
                            setUninstallMsg(null)
                            setConfirmUninstall(s.id)
                          }}
                        />
                      )
                    ) : (
                      // 内置技能（code-review / code-search / plugin-protocol）由代码提供，磁盘上没有目录
                      // ⇒ 显示不可点的灰按钮并说明原因（不点了报错、不静默失败）
                      <MarketCardButton label={t('skills.market.builtinLocked')} grey disabled />
                    )
                  }
                >
                  <MarketCardHead name={s.name} desc={s.description || t('market.noDesc')} />
                  <MarketTagRow>
                    <MarketTag label={s.source === 'user' ? t('chat.account.sourceUser') : t('chat.account.sourceBuiltin')} tone={s.source === 'user' ? 'blue' : 'gray'} />
                  </MarketTagRow>
                  <MarketMetaRow>
                    <span>{s.id}</span>
                  </MarketMetaRow>
                </MarketCardShell>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 搜索区 */}
          <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
                <span style={{ display: 'inline-flex', color: 'var(--text-faint)' }}>
                  <IconSearch />
                </span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch()
                  }}
                  placeholder={t('skills.market.searchPlaceholder')}
                  style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13 }}
                />
                {query ? (
                  <button onClick={() => setQuery('')} title={t('common.clear')} style={{ ...smallIconBtn, color: 'var(--text-faint)' }}>
                    <IconClose />
                  </button>
                ) : null}
              </div>
              <button onClick={() => void runSearch()} disabled={searching} style={{ ...btn('var(--accent)', '#fff'), opacity: searching ? 0.6 : 1, cursor: searching ? 'default' : 'pointer' }}>
                {searching ? t('skills.market.searching') : t('skills.market.search')}
              </button>
              <button title={t('common.refresh')} onClick={() => void runSearch()} style={{ ...smallIconBtn, color: 'var(--text-muted)', width: 34, height: 34 }}>
                <IconRefresh />
              </button>
            </div>

            {/* 来源 + 分类（chip 行，随主题变量；样式取自插件市场 FilterChip） */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <MarketFilterChip active={source === 'all'} onClick={() => setSource('all')} label={t('skills.market.sourceAll')} />
              <MarketFilterChip active={source === 'clawhub'} onClick={() => setSource('clawhub')} label="ClawHub" />
              <MarketFilterChip active={source === 'skillhub'} onClick={() => setSource('skillhub')} label="SkillHub" />
              <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 6px' }} />
              <MarketFilterChip active={category === ''} onClick={() => setCategory('')} label={t('skills.market.categoryAll')} />
              {CATEGORIES.map((c) => (
                <MarketFilterChip key={c} active={category === c} onClick={() => setCategory(c)} label={t(`skills.market.cat.${c}`)} />
              ))}
            </div>
          </div>

          {/* 主体：左结果卡片网格 + 右详情 */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {searchErr ? (
                <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tint-red)', color: 'var(--danger)', fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <IconWarn />
                  <span style={{ wordBreak: 'break-word' }}>{t('skills.market.searchFailed', { msg: searchErr })}</span>
                </div>
              ) : null}
              {!searched ? <Hint text={t('skills.market.startHint')} /> : null}
              {searching ? (
                <div style={MARKET_GRID_STYLE}>
                  {[0, 1, 2, 3].map((i) => (
                    <MarketSkeletonCard key={i} />
                  ))}
                </div>
              ) : searched && items.length === 0 ? (
                <Hint text={t('skills.market.empty')} />
              ) : (
                <div style={MARKET_GRID_STYLE}>
                  {items.map((it) => (
                    <SkillResultCard
                      key={`${it.source}:${it.slug}`}
                      item={it}
                      active={selected?.slug === it.slug && selected?.source === it.source}
                      onOpen={() => void openDetail(it)}
                      onInstall={() => {
                        pendingInstall.current = `${it.source}:${it.slug}`
                        void openDetail(it)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* 详情区：未选中时给引导，不占空白 */}
            <div style={{ width: 360, flexShrink: 0, borderLeft: '1px solid var(--border)', background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {!selected ? (
                <Hint text={t('skills.market.selectHint')} />
              ) : (
                <>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-word' }}>{preview?.name || selected.displayName}</div>
                    <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text-faint)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <span>{selected.source === 'clawhub' ? 'ClawHub' : 'SkillHub'}</span>
                      <span>{selected.authorName}</span>
                      {selected.version ? <span>v{selected.version}</span> : null}
                      <span>{t('skills.market.downloads', { n: selected.downloads })}</span>
                    </div>
                  </div>

                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {previewLoading ? <Hint text={t('skills.market.loading')} /> : null}
                    {previewErr ? (
                      <div style={{ fontSize: 12.5, color: 'var(--danger)', wordBreak: 'break-word', display: 'flex', gap: 6 }}>
                        <IconWarn />
                        <span>{previewErr}</span>
                      </div>
                    ) : null}

                    {preview ? (
                      <>
                        {/* 风险等级 + 告警 */}
                        <div style={{ padding: '8px 10px', borderRadius: 8, background: RISK_TINT[preview.riskLevel] }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: RISK_COLOR[preview.riskLevel] }}>
                            <IconWarn />
                            {t('skills.market.riskLabel', { level: riskLabel(preview.riskLevel) })}
                          </div>
                          {preview.warnings.length === 0 ? (
                            <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text-secondary)' }}>{t('skills.market.noWarnings')}</div>
                          ) : (
                            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {preview.warnings.map((w, i) => (
                                <li key={i} style={{ wordBreak: 'break-word' }}>
                                  {w}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        {/* 依赖 */}
                        <Field label={t('skills.market.requiresBins')} value={preview.requiresBins.length ? preview.requiresBins.join(', ') : t('skills.market.none')} missing={preview.missingBins} missingLabel={t('skills.market.missing')} />
                        <Field label={t('skills.market.requiresEnv')} value={preview.requiresEnv.length ? preview.requiresEnv.join(', ') : t('skills.market.none')} missing={preview.missingEnv} missingLabel={t('skills.market.missing')} />
                        {preview.description ? (
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, wordBreak: 'break-word' }}>{preview.description}</div>
                        ) : null}

                        {/* SKILL.md 全文（纯文本渲染，绝不 dangerouslySetInnerHTML） */}
                        <div>
                          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('skills.market.skillMd')}</div>
                          <pre
                            style={{
                              margin: 0,
                              padding: 10,
                              borderRadius: 8,
                              background: 'var(--bg-sidebar)',
                              border: '1px solid var(--border-soft)',
                              fontSize: 11,
                              lineHeight: 1.55,
                              color: 'var(--text-secondary)',
                              maxHeight: 260,
                              overflow: 'auto',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {preview.instructions}
                          </pre>
                        </div>
                      </>
                    ) : null}

                    {/* 进度 + 结果 */}
                    {installing ? (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {t('skills.market.installing')}
                        {progress ? ` · ${t(STAGE_KEY[progress.stage])}` : ''}
                      </div>
                    ) : null}
                    {result ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontSize: 12, lineHeight: 1.6, wordBreak: 'break-word', color: result.ok ? 'var(--success)' : 'var(--danger)' }}>{result.text}</div>
                        {result.ok ? (
                          <button onClick={() => setTab('installed')} style={{ ...btn('var(--accent)', '#fff'), alignSelf: 'flex-start' }}>
                            {t('skills.market.viewInstalled')}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {/* 安装按钮：高风险需二次确认（界面第一道闸门） */}
                  <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
                    {selected.installed && !confirming ? (
                      <span style={{ fontSize: 12, color: 'var(--success)', flex: 1 }}>{t('skills.market.alreadyInstalled')}</span>
                    ) : null}
                    <button
                      onClick={onInstallClick}
                      disabled={installing || !preview}
                      style={{
                        ...btn(confirming || highRisk ? 'var(--danger)' : 'var(--accent)', '#fff'),
                        marginLeft: 'auto',
                        opacity: installing || !preview ? 0.6 : 1,
                        cursor: installing || !preview ? 'default' : 'pointer',
                      }}
                    >
                      {installing ? t('skills.market.installing') : confirming ? t('skills.market.confirmInstall') : t('skills.market.install')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** 市场结果卡片：卡片视觉与插件市场一致（图标 + 名称 + 简介 + 标签 + 元信息 + 底部按钮） */
function SkillResultCard({ item, active, onOpen, onInstall }: { item: SkillMarketItem; active: boolean; onOpen: () => void; onInstall: () => void }): React.JSX.Element {
  return (
    <MarketCardShell clickable active={active} onClick={onOpen} footer={<MarketCardButton label={item.installed ? t('skills.market.installed') : t('skills.market.install')} grey={item.installed} onClick={onInstall} />}>
      <MarketCardHead name={item.displayName} desc={item.summary} />
      <MarketTagRow>
        <MarketTag label={item.source === 'clawhub' ? 'ClawHub' : 'SkillHub'} tone="gray" />
        {item.category ? <MarketTag label={item.category} tone="blue" /> : null}
        {item.installed ? <MarketTag label={t('skills.market.installed')} tone="green" /> : null}
      </MarketTagRow>
      <MarketMetaRow>
        <span>{item.authorName}</span>
        {item.version ? <span>v{item.version}</span> : null}
        <span>{t('skills.market.downloads', { n: item.downloads })}</span>
        {typeof item.installs === 'number' ? <span>{t('skills.market.installs', { n: item.installs })}</span> : null}
      </MarketMetaRow>
    </MarketCardShell>
  )
}

/** 依赖字段（带「本机缺失」高亮） */
function Field({ label, value, missing, missingLabel }: { label: string; value: string; missing: string[]; missingLabel: string }): React.JSX.Element {
  return (
    <div style={{ fontSize: 11.5, lineHeight: 1.6 }}>
      <span style={{ color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ marginLeft: 6, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{value}</span>
      {missing.length > 0 ? (
        <span style={{ marginLeft: 6, color: 'var(--danger)' }}>
          {missingLabel}
          {missing.join(', ')}
        </span>
      ) : null}
    </div>
  )
}

/** 居中的灰字引导/空态（与其它面板空态同风格） */
function Hint({ text }: { text: string }): React.JSX.Element {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, lineHeight: 1.7 }}>{text}</div>
}
