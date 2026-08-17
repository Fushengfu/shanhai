import { describe, it, expect } from 'vitest'
import type { GatewayModel } from '@shanhai/auth'
import { createLlmGateway } from '../src/gateway'

function model(id: string, tier: 'flagship' | 'value' | 'vision'): GatewayModel {
  return { id, name: id, tier, apiKey: 'k', baseUrl: 'https://x' }
}

describe('LlmGateway 路由', () => {
  const gateway = createLlmGateway([
    model('gpt-flagship', 'flagship'),
    model('gpt-value', 'value'),
    model('gpt-vision', 'vision'),
  ])

  it('同层优先', () => {
    expect(gateway.resolveModel('value')?.id).toBe('gpt-value')
    expect(gateway.resolveModel('vision')?.id).toBe('gpt-vision')
  })

  it('override 优先', () => {
    expect(gateway.resolveModel('value', 'gpt-vision')?.id).toBe('gpt-vision')
  })

  it('无 override 时返回 undefined', () => {
    const empty = createLlmGateway([])
    expect(empty.resolveModel('value')).toBeUndefined()
  })
})
