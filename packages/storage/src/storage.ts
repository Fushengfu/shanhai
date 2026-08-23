import { createHash } from 'node:crypto'

/** 网关上传凭证接口（/api/member/storage/upload-token）返回的 data 结构 */
interface UploadTokenData {
  token: string
  key: string
  upload_url?: string
  public_base_url?: string
  provider?: string
  reused?: boolean
  public_url?: string
}

export interface UploadImageParams {
  /** 图片 base64（不含 data: 前缀） */
  imageBase64: string
  /** 会员 JWT（登录后获取，用于调网关上传凭证接口） */
  token: string
  /** 网关基地址，默认 https://agent.bjctykj.com */
  gatewayBase?: string
  /** MIME 类型，默认 image/png */
  mimeType?: string
}

const DEFAULT_GATEWAY_BASE = 'https://agent.bjctykj.com'

/**
 * 把图片 base64 上传到云存储，返回 https 公网访问链接。
 *
 * 对齐 Taco：统一走网关后台 API 拿上传凭证（无需本地配置七牛云/OSS 凭证），
 * 然后直传云存储。相同图片 hash 去重（复用已有链接）。
 *
 * 失败（未登录 / 网关异常 / 上传失败 / 超时）返回 null，由调用方回退（如降级返回 base64）。
 */
export async function uploadImageToCloud(params: UploadImageParams): Promise<string | null> {
  const { imageBase64, token, gatewayBase = DEFAULT_GATEWAY_BASE, mimeType = 'image/png' } = params

  if (!imageBase64 || !token) return null

  try {
    const bytes = Buffer.from(imageBase64, 'base64')
    if (bytes.length === 0) return null

    // 计算 SHA-256 hash（网关侧去重：相同图片只存一份）
    const hash = createHash('sha256').update(bytes).digest('hex')
    const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
    const fileName = `screenshot_${Date.now()}.${ext}`

    // 1. 调网关拿上传凭证
    const tokenResp = await fetchWithTimeout(
      `${gatewayBase.replace(/\/+$/, '')}/api/member/storage/upload-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ file_name: fileName, mime_type: mimeType, hash }),
      },
    )
    if (!tokenResp.ok) return null

    const tokenJson = (await tokenResp.json()) as { code?: number; message?: string; data?: UploadTokenData }
    if (tokenJson.code !== 0 || !tokenJson.data) return null
    const data = tokenJson.data

    // 2. hash 去重命中：直接返回已有链接
    if (data.reused === true && data.public_url) return data.public_url

    // 3. 直传云存储
    const formData = new FormData()
    formData.append('token', data.token)
    formData.append('key', data.key)
    formData.append('file', new Blob([bytes], { type: mimeType }), fileName)

    let uploadUrl = data.upload_url || 'https://up.qiniup.com'
    let uploadResp = await fetchWithTimeout(uploadUrl, { method: 'POST', body: formData })

    // 七牛云跨区域重试（400/405：上传区域不对，从错误信息提取正确区域重试）
    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => '')
      if (uploadResp.status === 400 || uploadResp.status === 405) {
        const retryHost = errText.match(/up-[a-z0-9]+\.qiniup\.com/)?.[0]
        if (retryHost) {
          uploadUrl = `https://${retryHost}`
          uploadResp = await fetchWithTimeout(uploadUrl, { method: 'POST', body: formData })
        }
      }
      if (!uploadResp.ok) return null
    }

    // 4. 构造公网 URL（校验 public_base_url 必须是有效 http(s)://host 格式）
    const publicBaseUrl = String(data.public_base_url || '').replace(/\/+$/, '')
    if (!/^https?:\/\/[^/]+/.test(publicBaseUrl)) return null
    return `${publicBaseUrl}/${data.key}`
  } catch {
    return null
  }
}

/** 带超时的 fetch：防止网络挂起导致截图上传永久卡住 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
