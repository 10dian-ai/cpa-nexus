import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ presets: vi.fn(), forward: vi.fn(), log: vi.fn() }))
vi.mock('../server/lib/modules', () => ({ requireModule: async () => undefined }))
vi.mock('../server/lib/logs', () => ({ insertRequestLog: fixture.log }))
vi.mock('../server/lib/devin2api/forward', () => ({ forwardDevin2Api: fixture.forward }))
vi.mock('../server/lib/devin2api/routing', () => ({
  listDevin2ApiGroupModels: async () => [],
  resolveDevin2ApiModel: async () => ({ model: 'cascade', account: { id: 'account-b' }, matchedGroupId: 'group-b' }),
}))
vi.mock('../server/lib/presets', () => ({ resolveKeyPresetStack: fixture.presets }))
vi.mock('../server/lib/presets/engine', () => ({
  applyPresetStack: (_presets: unknown, body: unknown) => body,
  resolvePresetGenerationType: () => 'normal',
}))

import { handleDevin2ApiInference } from '../server/lib/devin2api/inference'

describe('Devin preset scope', () => {
  it('does not merge presets from other groups on the same key', async () => {
    fixture.presets.mockResolvedValue([])
    fixture.forward.mockResolvedValue(undefined)
    fixture.log.mockResolvedValue(undefined)
    const headers = new Map<string, unknown>()
    const event = { node: { res: { statusCode: 200, setHeader: (name: string, value: unknown) => headers.set(name, value), getHeader: (name: string) => headers.get(name) } } } as any
    await handleDevin2ApiInference(event, { keyId: 'key', groupIds: ['group-a', 'group-b'], protocolPath: 'chat/completions', body: { model: 'devin/cascade', messages: [] } })
    expect(fixture.presets).toHaveBeenCalledWith('key', ['group-b'])
  })
})
