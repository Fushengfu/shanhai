import { useCallback, useEffect, useMemo, useState } from 'react'
import { WindowTitleBar } from '../components/WindowTitleBar'
import { IconStore, IconSearch, IconRefresh } from '../components/icons'
import { smallIconBtn } from '../components/ui'
import { useThemeSync } from '../theme'

/** 市场插件条目（与 preload listMarketPlugins 返回项对齐） */
interface MarketItem {
  id: string
  name: string
  purpose: string
  version?: string
  author?: string
  hasUI?: boolean
  categories?: string[]
  iconUrl?: string
  fileSha256?: string
  fileSize?: number
  installed?: boolean
}

/** 「我已安装」插件条目（与 preload listMyPlugins 返回项对齐） */
interface MyItem {
  id: string
  name: string
  purpose?: string
  /** 本地版本：自研工程 package.json version 优先，否则已安装 manifest version */
  version?: string
  /** 是否自研（plugins-workspace 下存在同 id 工程） */
  selfMade: boolean
  installed: boolean
  /** 网关是否有该 plugin_id 的提交记录 */
  submitted: boolean
  /** 网关最新版本 */
  gatewayVersion?: string
  /** 网关最新状态 */
  gatewayStatus?: string
  /** 网关是否有已审批版本 */
  hasApproved?: boolean
}

/** 行业分类枚举（与 plugin_share_pack / 网关 hasUI/categories 对齐） */
const CATEGORIES = ['效率办公', '内容创作', '视频生成', '设计', '数据分析', '生活工具', '行业专属', '其他'] as const

/** 网关接口未就绪时的 mock 数据（仅用于把 UI 跑通；联调点：网关公开接口上线后自动切换真实数据） */
const MOCK_PLUGINS: MarketItem[] = [
  { id: 'shortdrama', name: 'AI视频工坊', purpose: '多集网剧短剧工作台：分镜剧本、AI 视频生成（万相 wan3.0-video 经内核桥 videoGen）', version: '1.1.2', author: '山海官方', hasUI: true, categories: ['视频生成', '内容创作'] },
  { id: 'todo-list', name: '待办清单', purpose: '轻量待办事项管理插件：增删改查、到期提醒，支持拖拽排序', version: '2.0.0', author: '山海官方', hasUI: true, categories: ['效率办公'] },
  { id: 'markdown-notes', name: 'Markdown 笔记', purpose: '本地 Markdown 笔记：实时预览、目录大纲、导出 HTML', version: '1.0.3', author: '社区', hasUI: true, categories: ['效率办公', '内容创作'] },
  { id: 'image-compress', name: '图片压缩', purpose: '批量图片压缩工具（纯工具插件，无界面窗口）', version: '0.9.1', author: '社区', hasUI: false, categories: ['设计', '生活工具'] },
]

/** 解析版本号为数字段（semver 逐段比较，1.10.0 > 1.9.0 正确，禁止字符串字典序） */
function parseVersion(v?: string): number[] {
  if (!v) return []
  const m = String(v).trim().match(/\d+/g)
  return m ? m.map((n) => parseInt(n, 10)) : []
}

/** semver 比较：a > b 返回 1，a < b 返回 -1，相等返回 0 */
function compareVersions(a?: string, b?: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 分享按钮状态机（仅自研插件）：
 *  - 网关无该 plugin_id 提交记录 → 'share'（分享）
 *  - 网关有记录 + 本地版本 > 网关最新版本 → 'upgrade'（提交升级版本共享）
 *  - 网关有记录 + 本地版本 <= 网关最新版本 → null（不显示按钮）
 *  非自研插件 → null
 */
function shareAction(p: MyItem): 'share' | 'upgrade' | null {
  if (!p.selfMade) return null
  if (!p.submitted) return 'share'
  if (compareVersions(p.version, p.gatewayVersion) > 0) return 'upgrade'
  return null
}

export function PluginMarketApp({ onClose }: { onClose: () => void }): React.JSX.Element {
  useThemeSync()

  const [tab, setTab] = useState<'browse' | 'mine' | 'submit'>('browse')
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState<string>('')
  const [hasUI, setHasUI] = useState<boolean | ''>('')

  const [plugins, setPlugins] = useState<MarketItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mockMode, setMockMode] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  // 「我已安装」tab 状态
  const [myPlugins, setMyPlugins] = useState<MyItem[]>([])
  const [mineLoading, setMineLoading] = useState(false)
  const [mineError, setMineError] = useState('')
  const [sharing, setSharing] = useState<string | null>(null)
  const [shareMsg, setShareMsg] = useState('')
  const [shareOk, setShareOk] = useState(true)
  // 卸载状态（危险操作，二次确认后才真正调用）
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  const [uninstallMsg, setUninstallMsg] = useState('')
  const [uninstallOk, setUninstallOk] = useState(true)

  // 当前登录账号（提交/分享必须以登录账号发布；未登录时前置禁用按钮 + 提示）
  const [auth, setAuth] = useState<{ loggedIn: boolean; username: string | null }>({ loggedIn: false, username: null })

  const load = useCallback(async (kw: string, cat: string, ui: boolean | '') => {
    setLoading(true)
    setError('')
    try {
      const res = await window.shanhai?.listMarketPlugins({ keyword: kw, category: cat, hasUI: ui, page: 1, pageSize: 50 })
      if (res && res.ok) {
        setPlugins(res.plugins)
        setTotal(res.total)
        setMockMode(false)
        return
      }
      // 接口未就绪 → 降级 mock（联调点：网关公开接口上线后此分支不再触发）
      setMockMode(true)
      setError(res?.error ?? '')
      const kwl = kw.trim().toLowerCase()
      const filtered = MOCK_PLUGINS.filter((p) => {
        if (kwl && !(p.name.toLowerCase().includes(kwl) || p.purpose.toLowerCase().includes(kwl))) return false
        if (cat && !(p.categories ?? []).includes(cat)) return false
        if (ui !== '' && p.hasUI !== ui) return false
        return true
      })
      setPlugins(filtered)
      setTotal(filtered.length)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMine = useCallback(async () => {
    setMineLoading(true)
    setMineError('')
    setShareMsg('')
    try {
      const res = await window.shanhai?.listMyPlugins()
      if (res && res.ok) {
        setMyPlugins(res.plugins)
        setMineError(res.mineError ?? '')
      } else {
        setMyPlugins([])
        setMineError(res?.mineError ?? '读取已安装插件失败')
      }
    } catch (e) {
      setMyPlugins([])
      setMineError(e instanceof Error ? e.message : String(e))
    } finally {
      setMineLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(keyword, category, hasUI)
    void loadMine()
    // 读取当前登录态（提交/分享必须以登录账号发布，未登录时前置禁用按钮）
    void window.shanhai
      ?.status()
      .then((s) => setAuth({ loggedIn: !!s?.loggedIn, username: s?.username ?? null }))
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleInstall = async (id: string): Promise<void> => {
    if (installing) return
    setInstalling(id)
    setNotice('')
    try {
      const res = await window.shanhai?.installMarketPlugin(id)
      setNotice(res?.ok ? (res.message ?? '已安装') : (res?.message ?? '安装失败'))
      if (res?.ok) {
        // 安装成功后刷新列表（标记「已安装」）+ 刷新「我已安装」区块
        void load(keyword, category, hasUI)
        void loadMine()
      }
    } finally {
      setInstalling(null)
    }
  }

  const handleShare = async (id: string): Promise<void> => {
    if (sharing) return
    setSharing(id)
    setShareMsg('')
    try {
      const res = await window.shanhai?.submitPluginToMarket(id)
      setShareOk(!!res?.ok)
      setShareMsg(res?.ok ? (res.message ?? '已提交') : (res?.message ?? '提交失败'))
      // 提交后刷新「我已安装」区块（更新 submitted / gatewayVersion 状态）
      void loadMine()
    } catch (err) {
      // IPC 桥异常（未返回 res 时）也必须有可见提示，防止「点了没反应」
      setShareOk(false)
      setShareMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setSharing(null)
    }
  }

  const handleUninstall = async (id: string): Promise<void> => {
    if (uninstalling) return
    setUninstalling(id)
    setUninstallMsg('')
    try {
      const res = await window.shanhai?.uninstallMarketPlugin(id)
      setUninstallOk(!!res?.ok)
      setUninstallMsg(res?.ok ? (res.message ?? '已卸载') : (res?.message ?? '卸载失败'))
      if (res?.ok) {
        // 卸载成功后刷新「我已安装」区块 + 刷新「发现」列表（更新 installed 标记）
        void loadMine()
        void load(keyword, category, hasUI)
      }
    } catch (err) {
      setUninstallOk(false)
      setUninstallMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setUninstalling(null)
    }
  }

  const filteredPlugins = useMemo(() => plugins, [plugins])
  // 「我的提交」记录：已安装插件里网关有提交记录的那些（submitted=true）
  const submittedPlugins = useMemo(() => myPlugins.filter((p) => p.submitted), [myPlugins])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-app)', color: 'var(--text)', fontFamily: 'system-ui, sans-serif' }}>
      <WindowTitleBar icon={<IconStore />} title="创意空间" subtitle="浏览、安装与提交插件" onClose={onClose} />

      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {[
          { k: 'browse', label: '发现' },
          { k: 'mine', label: '我已安装' },
          { k: 'submit', label: '我的提交' },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k as 'browse' | 'mine' | 'submit')}
            style={{
              padding: '10px 14px',
              border: 'none',
              borderBottom: tab === t.k ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent',
              color: tab === t.k ? 'var(--text)' : 'var(--text-muted)',
              fontSize: 13,
              fontWeight: tab === t.k ? 600 : 500,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>
        {tab === 'browse' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 搜索 + 筛选 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
                  <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}><IconSearch /></span>
                  <input
                    value={keyword}
                    onChange={(e) => {
                      setKeyword(e.target.value)
                      void load(e.target.value, category, hasUI)
                    }}
                    placeholder="搜索插件名称 / 用途"
                    style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13 }}
                  />
                </div>
                <button
                  title="刷新"
                  onClick={() => void load(keyword, category, hasUI)}
                  style={{ ...smallIconBtn, color: 'var(--text-muted)', width: 34, height: 34 }}
                >
                  <IconRefresh />
                </button>
              </div>

              {/* hasUI + 分类筛选 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <FilterChip label="全部" active={hasUI === ''} onClick={() => { setHasUI(''); void load(keyword, category, '') }} />
                <FilterChip label="有界面" active={hasUI === true} onClick={() => { setHasUI(true); void load(keyword, category, true) }} />
                <FilterChip label="纯工具" active={hasUI === false} onClick={() => { setHasUI(false); void load(keyword, category, false) }} />
                <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 6px' }} />
                <FilterChip label="全部分类" active={category === ''} onClick={() => { setCategory(''); void load(keyword, '', hasUI) }} />
                {CATEGORIES.map((c) => (
                  <FilterChip key={c} label={c} active={category === c} onClick={() => { setCategory(c); void load(keyword, c, hasUI) }} />
                ))}
              </div>
            </div>

            {/* 状态提示 */}
            {mockMode && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tint-yellow-soft, rgba(255,193,7,0.12))', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
                网关创意空间接口尚未就绪（{error || '网络错误'}），当前展示 mock 数据。网关接口上线后将自动切换为真实插件列表。
              </div>
            )}
            {notice && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tint-green-soft, rgba(76,175,80,0.14))', color: 'var(--text)', fontSize: 13, lineHeight: 1.6 }}>{notice}</div>
            )}

            {/* 结果统计 */}
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{loading ? '加载中…' : `共 ${total} 个应用`}</div>

            {/* 列表：骨架屏 / 空态 / 应用卡片网格 */}
            {loading ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            ) : filteredPlugins.length === 0 ? (
              <div style={{ padding: '56px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
                <div style={{ opacity: 0.45, display: 'inline-flex' }}><span style={{ transform: 'scale(1.6)', display: 'inline-flex' }}><IconStore /></span></div>
                <div>没有找到匹配的应用</div>
                <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>换个关键词或分类再试试</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
                {filteredPlugins.map((p) => (
                  <MarketCard key={p.id} p={p} installing={installing === p.id} onInstall={handleInstall} />
                ))}
              </div>
            )}
          </div>
        ) : tab === 'mine' ? (
          /* 我已安装 tab：本机已安装插件 + 自研标记 + 分享/升级按钮状态机 */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {!auth.loggedIn && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tint-yellow-soft, rgba(255,193,7,0.12))', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
                未登录。登录后才能提交「分享 / 提交升级版本共享」到创意空间。请先登录。
              </div>
            )}
            {mineError && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--tint-yellow-soft, rgba(255,193,7,0.12))', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
                网关「我的插件」接口（mine）未就绪（{mineError}），提交状态按「未提交」降级处理，自研插件将显示「分享」按钮。
              </div>
            )}
            {shareMsg && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: shareOk ? 'var(--tint-green-soft, rgba(76,175,80,0.14))' : 'rgba(239,68,68,0.14)', color: shareOk ? 'var(--text)' : 'var(--text-danger, #ef4444)', fontSize: 13, lineHeight: 1.6, wordBreak: 'break-all' }}>{shareMsg}</div>
            )}
            {uninstallMsg && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: uninstallOk ? 'var(--tint-green-soft, rgba(76,175,80,0.14))' : 'rgba(239,68,68,0.14)', color: uninstallOk ? 'var(--text)' : 'var(--text-danger, #ef4444)', fontSize: 13, lineHeight: 1.6, wordBreak: 'break-all' }}>{uninstallMsg}</div>
            )}

            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mineLoading ? '加载中…' : `共 ${myPlugins.length} 个已安装插件`}</div>
            {!mineLoading && myPlugins.length === 0 && (
              <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                还没有安装任何插件。去「发现」tab 下载安装，或提交自己的插件。
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
              {myPlugins.map((p) => (
                <MyCard
                  key={p.id}
                  p={p}
                  sharing={sharing === p.id}
                  loggedIn={auth.loggedIn}
                  onShare={handleShare}
                  uninstalling={uninstalling === p.id}
                  onUninstall={handleUninstall}
                />
              ))}
            </div>
          </div>
        ) : (
          /* 我的提交 tab：我的提交记录列表（审核状态） */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 我的提交记录列表 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>我的提交记录</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mineLoading ? '加载中…' : `共 ${submittedPlugins.length} 条提交记录`}</div>
              {submittedPlugins.length === 0 ? (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  还没有提交记录。提交自研插件后，这里会显示审核状态。
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
                  {submittedPlugins.map((p) => (
                    <SubmitRecordCard key={p.id} p={p} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--tint-blue-soft)' : 'var(--bg-panel)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

function Tag({ label, tone = 'blue' }: { label: string; tone?: 'blue' | 'gray' | 'green' | 'orange' | 'red' }): React.JSX.Element {
  const bg =
    tone === 'blue' ? 'var(--tint-blue-soft)' :
    tone === 'green' ? 'var(--tint-green-soft, rgba(76,175,80,0.14))' :
    tone === 'orange' ? 'var(--tint-orange-soft, rgba(255,152,0,0.14))' :
    tone === 'red' ? 'rgba(239,68,68,0.14)' :
    'var(--bg-subtle)'
  const color =
    tone === 'blue' ? 'var(--accent)' :
    tone === 'green' ? 'var(--success-text, #2e7d32)' :
    tone === 'orange' ? 'var(--warning-text, #b26a00)' :
    tone === 'red' ? 'var(--text-danger, #ef4444)' :
    'var(--text-muted)'
  return (
    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: bg, color, fontWeight: 600 }}>{label}</span>
  )
}

/** 字节数格式化为可读大小（KB / MB），用于卡片元信息 */
function formatSize(n?: number): string {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 应用图标：优先渲染真实 iconUrl（网关下发的公网链接）；
 * 无 iconUrl 或加载失败 → 降级为「名称首字母」占位（应用市场风格，避免空白/破图）。
 */
function AppIcon({ name, iconUrl, size = 52, radius = 13 }: { name: string; iconUrl?: string; size?: number; radius?: number }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        style={{ borderRadius: radius, objectFit: 'cover', display: 'block', flexShrink: 0, background: 'var(--bg-subtle)' }}
      />
    )
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, var(--tint-blue-soft), var(--bg-panel))',
        border: '1px solid var(--border-soft)',
        color: 'var(--accent)',
        fontWeight: 700,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {(name || '?').slice(0, 1).toUpperCase()}
    </div>
  )
}

/** 应用卡片：图标 + 名称 + 一句话简介 + 元信息标签 + 操作按钮，hover 悬浮阴影/上移 */
function MarketCard({ p, installing, onInstall }: { p: MarketItem; installing: boolean; onInstall: (id: string) => void }): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const sizeLabel = formatSize(p.fileSize)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 18,
        borderRadius: 16,
        border: `1px solid ${hover ? 'var(--accent)' : 'var(--border)'}`,
        background: 'var(--bg-panel)',
        boxShadow: hover ? '0 8px 24px rgba(0,0,0,0.10)' : '0 1px 3px rgba(0,0,0,0.04)',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        transition: 'box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease',
        cursor: 'pointer',
      }}
    >
      {/* 顶部：图标 + 名称 + 简介 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <AppIcon name={p.name} iconUrl={p.iconUrl} size={52} radius={13} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.purpose || '暂无简介'}</div>
        </div>
      </div>

      {/* 中间：元信息标签 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {p.hasUI ? <Tag label="界面" /> : <Tag label="工具" tone="gray" />}
        {(p.categories ?? []).slice(0, 3).map((c) => (
          <Tag key={c} label={c} tone="blue" />
        ))}
        {p.installed && <Tag label="已安装" tone="green" />}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {p.author && <span>来自 {p.author}</span>}
        {p.version && <span>v{p.version}</span>}
        {sizeLabel && <span>{sizeLabel}</span>}
      </div>

      {/* 底部：操作按钮（紧凑尺寸，不占满整卡；已安装 → 置灰描边，未安装 → 主色实心） */}
      <button
        onClick={() => onInstall(p.id)}
        disabled={installing || p.installed}
        style={{
          alignSelf: 'flex-start',
          padding: '7px 16px',
          borderRadius: 8,
          border: p.installed ? '1px solid var(--border)' : 'none',
          cursor: p.installed ? 'default' : 'pointer',
          background: p.installed ? 'transparent' : 'var(--accent)',
          color: p.installed ? 'var(--text-muted)' : '#fff',
          fontSize: 13,
          fontWeight: 600,
          transition: 'background 0.15s ease',
          opacity: installing ? 0.6 : 1,
        }}
      >
        {installing ? '安装中…' : p.installed ? '已安装' : '下载安装'}
      </button>
    </div>
  )
}

/** 「我已安装」插件卡片：复用「发现」面板卡片视觉（图标 + 名称 + 简介 + 标签 + 元信息 + 整宽操作按钮），
 *  同时承载「已安装」专属信息（自研标记 / 本地版本 / 网关版本 / 分享 / 提交升级版本共享）。 */
function MyCard({ p, sharing, loggedIn, onShare, uninstalling, onUninstall }: { p: MyItem; sharing: boolean; loggedIn: boolean; onShare: (id: string) => void; uninstalling: boolean; onUninstall: (id: string) => void }): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const action = shareAction(p)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 18,
        borderRadius: 16,
        border: `1px solid ${hover ? 'var(--accent)' : 'var(--border)'}`,
        background: 'var(--bg-panel)',
        boxShadow: hover ? '0 8px 24px rgba(0,0,0,0.10)' : '0 1px 3px rgba(0,0,0,0.04)',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        transition: 'box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease',
      }}
    >
      {/* 顶部：图标 + 名称 + 简介 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <AppIcon name={p.name} size={52} radius={13} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.purpose || '暂无简介'}</div>
        </div>
      </div>

      {/* 中间：标签 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Tag label="已安装" tone="green" />
        {p.selfMade && <Tag label="自研" tone="orange" />}
        {p.submitted && p.hasApproved && <Tag label="已上架" tone="blue" />}
      </div>

      {/* 元信息：本地版本 + 网关版本 */}
      <div style={{ fontSize: 11, color: 'var(--text-faint)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {p.version && <span>v{p.version}</span>}
        {p.submitted && p.gatewayVersion && <span>网关 v{p.gatewayVersion}</span>}
      </div>

      {/* 底部：操作按钮（分享 / 提交升级版本共享 / 已安装 + 卸载）同一行 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {action === 'share' && (
        <button
          onClick={() => onShare(p.id)}
          disabled={sharing || !loggedIn}
          style={{
            alignSelf: 'flex-start',
            padding: '7px 16px',
            borderRadius: 8,
            border: '1px solid var(--accent)',
            background: 'var(--tint-blue-soft)',
            color: 'var(--accent)',
            fontSize: 13,
            fontWeight: 600,
            cursor: sharing || !loggedIn ? 'not-allowed' : 'pointer',
            opacity: sharing || !loggedIn ? 0.55 : 1,
            transition: 'opacity 0.15s ease',
          }}
        >
          {sharing ? '分享中…' : '分享'}
        </button>
      )}
      {action === 'upgrade' && (
        <button
          onClick={() => onShare(p.id)}
          disabled={sharing || !loggedIn}
          style={{
            alignSelf: 'flex-start',
            padding: '7px 16px',
            borderRadius: 8,
            border: 'none',
            background: 'var(--accent)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: sharing || !loggedIn ? 'not-allowed' : 'pointer',
            opacity: sharing || !loggedIn ? 0.55 : 1,
            transition: 'opacity 0.15s ease',
          }}
        >
          {sharing ? '提交中…' : '提交升级版本共享'}
        </button>
      )}
      {action === null && (
        <button
          disabled
          style={{
            alignSelf: 'flex-start',
            padding: '7px 16px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'default',
          }}
        >
          已安装
        </button>
      )}

      {/* 卸载（危险操作，二次确认）：先点「卸载」进入确认态，再点「确认卸载」才真正调用 */}
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={uninstalling}
          style={{
            alignSelf: 'flex-start',
            padding: '7px 16px',
            borderRadius: 8,
            border: '1px solid var(--text-danger, #ef4444)',
            background: 'transparent',
            color: 'var(--text-danger, #ef4444)',
            fontSize: 12,
            fontWeight: 600,
            cursor: uninstalling ? 'not-allowed' : 'pointer',
            opacity: uninstalling ? 0.55 : 1,
            transition: 'opacity 0.15s ease',
          }}
        >
          {uninstalling ? '卸载中…' : '卸载'}
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid var(--text-danger, #ef4444)' }}>
          <div style={{ fontSize: 12, color: 'var(--text-danger, #ef4444)', lineHeight: 1.5 }}>确认卸载「{p.name}」？将从本机移除该插件，卸载不可恢复。</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => { setConfirming(false); onUninstall(p.id) }}
              disabled={uninstalling}
              style={{
                flex: 1,
                padding: '7px 0',
                borderRadius: 8,
                border: 'none',
                background: 'var(--text-danger, #ef4444)',
                color: '#fff',
                fontSize: 12,
                fontWeight: 600,
                cursor: uninstalling ? 'not-allowed' : 'pointer',
                opacity: uninstalling ? 0.55 : 1,
              }}
            >
              {uninstalling ? '卸载中…' : '确认卸载'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={uninstalling}
              style={{
                flex: 1,
                padding: '7px 0',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-panel)',
                color: 'var(--text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: uninstalling ? 'not-allowed' : 'pointer',
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

/** 加载骨架屏：占位卡片（无真实数据时的 loading 态，避免白板） */
function SkeletonCard(): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 18, borderRadius: 16, border: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: 13, background: 'var(--bg-subtle)' }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ width: '55%', height: 14, borderRadius: 6, background: 'var(--bg-subtle)' }} />
          <div style={{ width: '85%', height: 11, borderRadius: 5, background: 'var(--bg-subtle)' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: 44, height: 18, borderRadius: 8, background: 'var(--bg-subtle)' }} />
        ))}
      </div>
      <div style={{ width: '100%', height: 36, borderRadius: 10, background: 'var(--bg-subtle)' }} />
    </div>
  )
}

/** 网关审核状态 → 展示文案 + 色调（gatewayStatus: approved/pending/rejected） */
function reviewStatus(p: MyItem): { label: string; tone: 'green' | 'orange' | 'red' | 'gray' } {
  const s = (p.gatewayStatus ?? '').toLowerCase()
  if (s === 'approved') return { label: '已通过', tone: 'green' }
  if (s === 'rejected') return { label: '未通过', tone: 'red' }
  if (s === 'pending' || s === 'reviewing' || s === 'under_review' || s === 'submitted') return { label: '审核中', tone: 'orange' }
  if (p.hasApproved) return { label: '已通过', tone: 'green' }
  return { label: '审核中', tone: 'gray' }
}

/** 「我的提交」记录卡片：复用卡片视觉，突出展示审核状态（审核中 / 已通过 / 未通过） */
function SubmitRecordCard({ p }: { p: MyItem }): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const st = reviewStatus(p)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 18,
        borderRadius: 16,
        border: `1px solid ${hover ? 'var(--accent)' : 'var(--border)'}`,
        background: 'var(--bg-panel)',
        boxShadow: hover ? '0 8px 24px rgba(0,0,0,0.10)' : '0 1px 3px rgba(0,0,0,0.04)',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        transition: 'box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease',
      }}
    >
      {/* 顶部：图标 + 名称 + 简介 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <AppIcon name={p.name} size={52} radius={13} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.purpose || '暂无简介'}</div>
        </div>
      </div>

      {/* 审核状态 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Tag label={st.label} tone={st.tone} />
      </div>

      {/* 元信息：本地版本 + 网关版本 */}
      <div style={{ fontSize: 11, color: 'var(--text-faint)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {p.version && <span>v{p.version}</span>}
        {p.gatewayVersion && <span>网关 v{p.gatewayVersion}</span>}
      </div>
    </div>
  )
}
