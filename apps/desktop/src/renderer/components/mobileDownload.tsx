/**
 * 「手机端下载二维码」的**唯一实现**（设置页与左下角账号弹窗共用同一份）。
 *
 * 【为什么抽出来】二维码原本只有设置页（SettingsPanel）里那一处内联实现，本轮左下角账号区
 * 也要有一个同样的入口。两份各写一遍必然漂（本项目反复踩过的「两份真相」），故：
 *  - 生成 URL 的规则（含 `size=200x200` 这个请求尺寸）只在这里；
 *  - `<img>` 的尺寸、圆角、描边、alt 也只在这里。
 * ★设置页改为调用本文件后，渲染出的 `src` / `width` / `height` / `style` / `alt`
 *   **与改前逐字节一致**（默认参数就是原来那些值），会话页不产生任何外观变化。
 *
 * 【数据来源】`window.shanhai.getMobileApkInfo('com.amulet.shanhai')`（主进程 app-updater）。
 * 这里**不新写死任何下载地址**，也不自己生成二维码图片。
 *
 * 【为什么 QrServer 而不是本地生成】沿用设置页既有做法（`api.qrserver.com` 的 create-qr-code
 * 接口，把 downloadUrl 编码进查询串）。这属既有实现，本轮**照抄不动**；若将来要改成本地生成，
 * 必须两处一起改 —— 这正是抽成共用件的意义。
 */
import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { MobileApkInfo } from '../types'
import { t } from '../../shared/i18n'

/** 请求二维码图片时用的分辨率（与设置页原实现逐字一致，不要随意改） */
const MOBILE_QR_FETCH_SIZE = 200

/** 默认展示边长（设置页原值） */
const MOBILE_QR_DEFAULT_SIZE = 160

/**
 * 二维码图片地址（**唯一生成点**）。
 * 与设置页改前的模板串逐字一致：`...?size=200x200&data=<encodeURIComponent(downloadUrl)>`。
 */
export function mobileQrUrl(downloadUrl: string, fetchSize: number = MOBILE_QR_FETCH_SIZE): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${fetchSize}x${fetchSize}&data=${encodeURIComponent(downloadUrl)}`
}

/**
 * 二维码图片。<br>
 * 默认 `size=160` 即设置页原尺寸；弹窗里传更小的值只改 `width/height`，
 * **请求地址里的 `size=200x200` 不变**（两处拿到的就是同一张图）。
 */
export function MobileQrImage({ downloadUrl, size = MOBILE_QR_DEFAULT_SIZE }: { downloadUrl: string; size?: number }): React.JSX.Element {
  return (
    <img
      src={mobileQrUrl(downloadUrl)}
      alt={t('settings.apk.qrAlt')}
      width={size}
      height={size}
      style={{ borderRadius: 8, border: '1px solid var(--border-soft)' }}
    />
  )
}

/**
 * 读取手机端 APK 下载信息（设置页与账号弹窗共用）。
 * `active=false` 时不发请求（弹窗是悬停触发的，不该一进页面就拉接口）。
 */
export function useMobileApkInfo(active: boolean): {
  apk: MobileApkInfo | null
  loading: boolean
  error: string
} {
  const [apk, setApk] = useState<MobileApkInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const info = await window.shanhai?.getMobileApkInfo('com.amulet.shanhai')
      if (info?.downloadUrl) setApk(info)
      else setError(t('settings.mobile.noVersion'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void load()
  }, [active, load])

  return { apk, loading, error }
}

/** 提示语（版本号可选）：与设置页同一份措辞来源 */
export function mobileQrHint(version?: string): string {
  return version ? t('settings.apk.scanHintV', { v: version }) : t('settings.apk.scanHint')
}
