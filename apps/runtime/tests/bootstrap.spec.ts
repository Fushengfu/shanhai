import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'

describe('runtime 装配', () => {
  it('bootstrap 装配底座服务并跑通端到端 ReAct', async () => {
    const runtime = await bootstrap()
    const result = await runtime.run('你好')
    expect(result.length).toBeGreaterThan(0)
    await runtime.kernel.dispose()
  })
})
