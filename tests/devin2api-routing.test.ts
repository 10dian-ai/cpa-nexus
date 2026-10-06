import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; enabled: boolean; status: string; maxConcurrency?: number }>,
  bindings: [] as Array<{ account_id: string; group_id: string; created_at: string }>,
  loads: {} as Record<string, number>,
}))

vi.mock('../server/lib/devin2api/catalog', () => ({
  listDevin2ApiModels: async () => [{ id: 'cascade', object: 'model' }],
  stripDevin2ApiModel: (value: string) => value.startsWith('devin/') ? value.slice('devin/'.length) || null : null,
  namespaceDevin2ApiModels: (models: unknown[]) => models.map(model => ({ ...(model as object), id: 'devin/' + (model as { id: string }).id })),
}))
vi.mock('../server/lib/devin2api/accounts', () => ({
  listDevin2ApiAccounts: async () => fixture.accounts,
}))
vi.mock('../server/lib/db', () => ({
  getDb: () => {
    const sql = ((stringsOrValue: unknown, ..._values: unknown[]) => {
      if (Array.isArray(stringsOrValue) && !('raw' in (stringsOrValue as object))) return stringsOrValue
      return fixture.bindings
    }) as any
    return sql
  },
}))
vi.mock('../server/lib/devin2api/runtime', () => ({
  getDevin2ApiRuntimeLoad: (id: string) => fixture.loads[id] || 0,
}))

import { resolveDevin2ApiModel } from '../server/lib/devin2api/routing'

describe('Devin group-aware model routing', () => {
  beforeEach(() => {
    fixture.accounts = [
      { id: 'account-a', enabled: true, status: 'ready' },
      { id: 'account-b', enabled: true, status: 'ready' },
    ]
    fixture.bindings = [
      { account_id: 'account-a', group_id: 'group-a', created_at: '2026-01-01T00:00:00Z' },
      { account_id: 'account-b', group_id: 'group-b', created_at: '2026-01-01T00:00:00Z' },
    ]
    fixture.loads = {}
  })

  it('returns the first caller group that can serve the model', async () => {
    const result = await resolveDevin2ApiModel('devin/cascade', ['group-b', 'group-a'])
    expect(result).toMatchObject({ model: 'cascade', matchedGroupId: 'group-b', account: { id: 'account-b' } })
  })

  it('skips an empty group and reports the group that authorized the account', async () => {
    const result = await resolveDevin2ApiModel('devin/cascade', ['missing', 'group-a'])
    expect(result).toMatchObject({ matchedGroupId: 'group-a', account: { id: 'account-a' } })
  })

  it('prefers an available account and skips a saturated runtime', async () => {
    fixture.accounts = [
      { id: 'account-a', enabled: true, status: 'ready', maxConcurrency: 1 },
      { id: 'account-b', enabled: true, status: 'ready', maxConcurrency: 1 },
    ]
    fixture.bindings = [
      { account_id: 'account-a', group_id: 'group-a', created_at: '2026-01-01T00:00:00Z' },
      { account_id: 'account-b', group_id: 'group-a', created_at: '2026-01-01T00:00:00Z' },
    ]
    fixture.loads = { 'account-a': 1 }
    const result = await resolveDevin2ApiModel('devin/cascade', ['group-a'])
    expect(result).toMatchObject({ matchedGroupId: 'group-a', account: { id: 'account-b' } })
  })

  it('returns no route when every account in the matched group is saturated', async () => {
    fixture.accounts = [{ id: 'account-a', enabled: true, status: 'ready', maxConcurrency: 1 }]
    fixture.bindings = [{ account_id: 'account-a', group_id: 'group-a', created_at: '2026-01-01T00:00:00Z' }]
    fixture.loads = { 'account-a': 1 }
    await expect(resolveDevin2ApiModel('devin/cascade', ['group-a'])).resolves.toBeNull()
  })
})
