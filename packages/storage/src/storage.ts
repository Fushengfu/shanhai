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

/** 七牛统一直传结果 */
export interface QiniuUploadResult {
  ok: boolean
  /** 成功时的公网可访问 URL（public_base_url + '/' + key） */
  url?: string
  /** HTTP 状态码（网络异常时为 0） */
  status: number
  /** 失败时的响应体（可能含七牛错误提示，如 incorrect region, please use up-z1.qiniup.com） */
  body?: string
  /** 已尝试过的上传域名（含重试域名），用于排查 */
  attemptedHosts: string[]
}

/** 七牛统一直传入参 */
export interface QiniuUploadParams {
  /** 上传地址（网关/后端返回，如 https://up.qiniup.com） */
  uploadUrl: string
  /** 七牛上传凭证 token */
  token: string
  /** 上传 key（对象名，如 plugins/xxx.zip） */
  key: string
  /** 文件内容（Blob，FormData 表单上传用） */
  file: Blob
  /** 文件名（FormData file 字段的 filename） */
  filename: string
  /** 公网基址（如 https://store.bjctykj.com），成功时拼接成最终 URL */
  publicBaseUrl?: string
  /** 超时毫秒，默认 15000 */
  timeoutMs?: number
}

const DEFAULT_GATEWAY_BASE = 'https://agent.bjctykj.com'

/**
 * 统一七牛云直传（标准表单上传：token + key + file）。
 *
 * 内置「跨区域自愈」：首直传若返回 400/405 且响应体含「please use up-<region>.qiniup.com」，
 * 从错误体解析正确区域域名（如 up-z1.qiniup.com），用「同一 token/key/file」自动重试一次。
 * （七牛上传凭证本身区域无关；问题在网关返回的 upload_url 区域与 bucket 不匹配时才会触发——此函数
 * 在网关不改配置的情况下也能直传成功。图片上传与插件分享共用此函数，避免两处重复实现。）
 *
 * 返回 { ok, url?, status, body?, attemptedHosts }；失败不抛异常，错误原因在 body / status 中。
 */
export async function uploadToQiniu(params: QiniuUploadParams): Promise<QiniuUploadResult> {
  const { uploadUrl, token, key, file, filename, publicBaseUrl = '', timeoutMs = 15000 } = params
  const attemptedHosts: string[] = []

  const sendOnce = async (url: string): Promise<{ ok: boolean; status: number; body: string }> => {
    attemptedHosts.push(url.replace(/^https?:\/\//, ''))
    const form = new FormData()
    form.append('token', token)
    form.append('key', key)
    form.append('file', file, filename)
    let resp: Response
    try {
      resp = await fetchWithTimeout(url, { method: 'POST', body: form }, timeoutMs)
    } catch (err) {
      return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) }
    }
    const body = await resp.text().catch(() => '')
    return { ok: resp.ok, status: resp.status, body }
  }

  const first = await sendOnce(uploadUrl)
  if (first.ok) {
    return { ok: true, url: buildPublicUrl(publicBaseUrl, key), status: first.status, attemptedHosts }
  }

  // 跨区域自愈：错误体给出正确区域域名（如「incorrect region, please use up-z1.qiniup.com」）
  const regionHost =
    first.body.match(/use\s+(up-[\w.-]+\.qiniup\.com)/i)?.[1] ??
    first.body.match(/up-[a-z0-9]+\.qiniup\.com/i)?.[0]
  const regionUrl = regionHost ? `https://${regionHost}` : ''
  if (regionUrl && regionUrl.replace(/^https?:\/\//, '') !== uploadUrl.replace(/^https?:\/\//, '')) {
    const retry = await sendOnce(regionUrl)
    if (retry.ok) {
      return { ok: true, url: buildPublicUrl(publicBaseUrl, key), status: retry.status, attemptedHosts }
    }
    return { ok: false, status: retry.status, body: retry.body, attemptedHosts }
  }

  return { ok: false, status: first.status, body: first.body, attemptedHosts }
}

/** 构造公网 URL：public_base_url 需是合法 http(s)://host，key 去除首部斜杠 */
function buildPublicUrl(publicBaseUrl: string, key: string): string | undefined {
  const base = String(publicBaseUrl ?? '').replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]+/.test(base)) return undefined
  return `${base}/${String(key ?? '').replace(/^\/+/, '')}`
}

/** 登录账号上传凭证 + 直传的公共实现（图片 / 插件素材共用；凭证 = memberToken 的「登录账号上传」体系） */
async function doCloudUpload(file: {
  bytes: Buffer
  fileName: string
  mimeType: string
  token: string
  gatewayBase: string
}): Promise<string | null> {
  if (!file.token || file.bytes.length === 0) return null
  try {
    // 计算 SHA-256 hash（网关侧去重：相同文件只存一份）
    const hash = createHash('sha256').update(file.bytes).digest('hex')
    // 1. 调网关拿上传凭证（登录账号上传体系；与插件市场提交的凭证来源不同，保持独立）
    const tokenResp = await fetchWithTimeout(
      `${file.gatewayBase.replace(/\/+$/, '')}/api/member/storage/upload-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${file.token}` },
        body: JSON.stringify({ file_name: file.fileName, mime_type: file.mimeType, hash }),
      },
    )
    if (!tokenResp.ok) return null
    const tokenJson = (await tokenResp.json().catch(() => ({}))) as {
      code?: number
      message?: string
      data?: UploadTokenData
    }
    if (tokenJson.code !== 0 || !tokenJson.data) return null
    const data = tokenJson.data
    // 2. hash 去重命中：直接返回已有链接
    if (data.reused === true && data.public_url) return data.public_url
    // 3. 统一七牛直传（含跨区域自愈重试）；返回公网 URL 或 null（由调用方降级）
    // 拷贝到新的 Uint8Array<ArrayBuffer>，规避 TS 对 SharedArrayBuffer 与 Blob 构造的类型冲突
    const buf8 = new Uint8Array(file.bytes.byteLength)
    buf8.set(file.bytes)
    const result = await uploadToQiniu({
      uploadUrl: data.upload_url || 'https://up.qiniup.com',
      token: data.token,
      key: data.key,
      file: new Blob([buf8], { type: file.mimeType }),
      filename: file.fileName,
      publicBaseUrl: data.public_base_url || '',
    })
    return result.ok && result.url ? result.url : null
  } catch {
    return null
  }
}

/**
 * 把图片 base64 上传到云存储，返回 https 公网访问链接。
 *
 * 对齐 Taco：统一走网关后台 API 拿上传凭证（无需本地配置七牛云/OSS 凭证），
 * 然后直传云存储（复用 uploadToQiniu 统一直传）。相同图片 hash 去重（复用已有链接）。
 *
 * 失败（未登录 / 网关异常 / 上传失败 / 超时）返回 null，由调用方回退（如降级返回 base64）。
 */
export async function uploadImageToCloud(params: UploadImageParams): Promise<string | null> {
  const { imageBase64, token, gatewayBase = DEFAULT_GATEWAY_BASE, mimeType = 'image/png' } = params
  if (!imageBase64 || !token) return null
  try {
    const bytes = Buffer.from(imageBase64, 'base64')
    if (bytes.length === 0) return null
    const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
    const fileName = `screenshot_${Date.now()}.${ext}`
    return doCloudUpload({ bytes, fileName, mimeType, token, gatewayBase })
  } catch {
    return null
  }
}

/** 通用文件上传到云存储参数（插件素材 / 任意文件用） */
export interface UploadFileParams {
  /** 文件 base64（不含 data: 前缀） */
  dataBase64: string
  /** 会员 JWT（登录后获取，用于调网关上传凭证接口） */
  token: string
  /** 网关基地址，默认 https://agent.bjctykj.com */
  gatewayBase?: string
  /** MIME 类型，默认 application/octet-stream */
  mimeType?: string
  /** 文件名（含扩展名），默认 file.bin */
  fileName?: string
}

/**
 * 把任意文件（base64）上传到云存储，返回 https 公网访问链接。供第三方插件上传素材用。
 * 失败（未登录 / 网关异常 / 上传失败 / 超时）返回 null。
 */
export async function uploadFileToCloud(params: UploadFileParams): Promise<string | null> {
  const {
    dataBase64,
    token,
    gatewayBase = DEFAULT_GATEWAY_BASE,
    mimeType = 'application/octet-stream',
    fileName = 'file.bin',
  } = params
  if (!dataBase64 || !token) return null
  try {
    const bytes = Buffer.from(dataBase64, 'base64')
    if (bytes.length === 0) return null
    return doCloudUpload({ bytes, fileName, mimeType, token, gatewayBase })
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
