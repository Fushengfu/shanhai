import { describe, it, expect, vi, afterEach } from 'vitest'
import { uploadImageToCloud } from '../src/storage'

const GATEWAY = 'https://agent.bjctykj.com'
const IMG_BASE64 = Buffer.from('fake-image-bytes').toString('base64')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadImageToCloud', () => {
  it('无 token 时直接返回 null（不发起网络请求）', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const url = await uploadImageToCloud({ imageBase64: IMG_BASE64, token: '' })
    expect(url).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('空 imageBase64 返回 null', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const url = await uploadImageToCloud({ imageBase64: '', token: 't' })
    expect(url).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('网关上传凭证接口返回非 200 时返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 401 })))
    const url = await uploadImageToCloud({ imageBase64: IMG_BASE64, token: 't', gatewayBase: GATEWAY })
    expect(url).toBeNull()
  })

  it('网关返回 code !== 0 时返回 null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 1, message: 'invalid token', data: null }), { status: 200 }),
      ),
    )
    const url = await uploadImageToCloud({ imageBase64: IMG_BASE64, token: 't', gatewayBase: GATEWAY })
    expect(url).toBeNull()
  })

  it('hash 去重命中时直接返回已有 public_url，不再上传', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: { reused: true, public_url: 'https://cdn.example.com/a.png', key: 'a.png' },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const url = await uploadImageToCloud({ imageBase64: IMG_BASE64, token: 't', gatewayBase: GATEWAY })
    expect(url).toBe('https://cdn.example.com/a.png')
    expect(fetchSpy).toHaveBeenCalledTimes(1) // 只调凭证接口，不再直传
  })

  it('完整链路：拿凭证 → 直传 → 返回 public_base_url + key', async () => {
    const fetchSpy = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/api/member/storage/upload-token')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              token: 'upload-token',
              key: 'images/shot.png',
              upload_url: 'https://up.qiniup.com',
              public_base_url: 'https://cdn.example.com/',
            },
          }),
          { status: 200 },
        )
      }
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const url = await uploadImageToCloud({ imageBase64: IMG_BASE64, token: 't', gatewayBase: GATEWAY })
    expect(url).toBe('https://cdn.example.com/images/shot.png')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
