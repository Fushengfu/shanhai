import { describe, it, expect } from 'vitest'
import { bootstrap } from '../src/bootstrap'

/**
 * 自定义模型增删改的运行时行为（对齐「新增后无法使用、需重启」的根因排查）。
 * 核心验证：add/update/remove 后，模型列表与选中态即时生效，且触发 modelsChangedCallbacks（主进程 ui-store 据此重拉）。
 */
describe('自定义模型增删改', () => {
  it('addCustomModel：列表即时包含新模型，switchModel 生效（无需重启）', async () => {
    const runtime = await bootstrap()
    const m = await runtime.addCustomModel({
      name: '测试模型',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test-123',
      model: 'test-model',
      protocol: 'openai',
    })
    expect(m.id).toBeTruthy()
    expect(m.custom).toBe(true)
    expect(m.baseUrl).toBe('https://api.test.com/v1')
    expect(m.apiKey).toBe('sk-test-123')
    expect(m.model).toBe('test-model')

    // 不重启，直接 listModels 应包含新模型
    const list = await runtime.listModels()
    expect(list.some((x) => x.id === m.id)).toBe(true)

    // switchModel 后 getCurrentModelId 即时返回新 id（resolveProvider 成功解析）
    runtime.switchModel(m.id)
    expect(runtime.getCurrentModelId()).toBe(m.id)

    await runtime.removeCustomModel(m.id)
    await runtime.kernel.dispose()
  })

  it('updateCustomModel：编辑后列表反映新配置（apiKey/baseUrl/model 生效）', async () => {
    const runtime = await bootstrap()
    const m = await runtime.addCustomModel({
      name: '旧名',
      baseUrl: 'https://old.test.com/v1',
      apiKey: 'sk-old',
      model: 'old-model',
    })
    const updated = await runtime.updateCustomModel(m.id, {
      name: '新名',
      baseUrl: 'https://new.test.com/v1',
      apiKey: 'sk-new',
      model: 'new-model',
      protocol: 'openai',
    })
    expect(updated.baseUrl).toBe('https://new.test.com/v1')
    expect(updated.apiKey).toBe('sk-new')
    expect(updated.model).toBe('new-model')

    const list = await runtime.listModels()
    const found = list.find((x) => x.id === m.id)
    expect(found?.apiKey).toBe('sk-new')
    expect(found?.baseUrl).toBe('https://new.test.com/v1')
    expect(found?.model).toBe('new-model')

    await runtime.removeCustomModel(m.id)
    await runtime.kernel.dispose()
  })

  it('removeCustomModel：列表移除 + 当前选中被重置', async () => {
    const runtime = await bootstrap()
    const m = await runtime.addCustomModel({
      name: '待删除',
      baseUrl: 'https://del.test.com/v1',
      apiKey: 'sk-del',
      model: 'del-model',
    })
    runtime.switchModel(m.id)
    expect(runtime.getCurrentModelId()).toBe(m.id)

    await runtime.removeCustomModel(m.id)
    const list = await runtime.listModels()
    expect(list.some((x) => x.id === m.id)).toBe(false)
    // 删除的正是当前选中模型 → 选中态被清空
    expect(runtime.getCurrentModelId()).toBe('')

    await runtime.kernel.dispose()
  })

  it('onModelsChanged：add/update/remove 均触发回调（主进程 ui-store 据此重拉）', async () => {
    const runtime = await bootstrap()
    let calls = 0
    const off = runtime.onModelsChanged(() => {
      calls += 1
    })

    const m = await runtime.addCustomModel({
      name: '回调测试',
      baseUrl: 'https://cb.test.com/v1',
      apiKey: 'sk-cb',
      model: 'cb-model',
    })
    await runtime.updateCustomModel(m.id, {
      name: '回调测试2',
      baseUrl: 'https://cb2.test.com/v1',
      apiKey: 'sk-cb2',
      model: 'cb-model2',
    })
    await runtime.removeCustomModel(m.id)

    // add / update / remove 各触发一次（不含 restoreCredentials 等其它来源）
    expect(calls).toBeGreaterThanOrEqual(3)

    off()
    await runtime.kernel.dispose()
  })
})
