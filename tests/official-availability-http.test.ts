import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createError, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficialCatalogModel, OfficialCatalogView } from '../shared/official-catalog'

const fixture = vi.hoisted(() => ({
  authorized: true, catalog: null as OfficialCatalogView | null, previous: null as OfficialCatalogView | null,
  rows: new Map<string, unknown>(), sqlCalls: [] as string[], cache: vi.fn(), publish: vi.fn(), bridge: vi.fn(), sync: vi.fn(),
}))
vi.mock('../server/lib/auth', () => ({ requireAdmin: async () => { if (!fixture.authorized) throw createError({ statusCode: 401 }) } }))
vi.mock('../server/lib/official-catalog', () => ({ getOfficialCatalog: async () => fixture.previous, syncOfficialCatalog: fixture.sync }))
vi.mock('../server/lib/commandcode-bridge', () => ({ refreshCommandcodeBridge: fixture.bridge }))
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({ set: fixture.cache }) }))
vi.mock('../server/lib/events', () => ({ publishUpdate: fixture.publish }))
vi.mock('../server/lib/db', () => {
  const sql: any = (strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings, 'raw')) return strings
    const query = strings.join('?').replace(/\s+/g, ' ').trim()
    fixture.sqlCalls.push(query)
    if (query.startsWith('INSERT INTO model_catalog')) fixture.rows.set(String(values[0]), values[2])
    else if (query.startsWith('DELETE FROM model_catalog')) {
      const keep = query.includes('NOT IN') ? new Set(values[0] as string[]) : new Set<string>()
      for (const id of fixture.rows.keys()) if (!keep.has(id)) fixture.rows.delete(id)
    } else throw new Error('Unexpected SQL ' + query)
    return Promise.resolve([])
  }
  sql.json = (value: unknown) => value
  sql.begin = (run: (transaction: unknown) => unknown) => run(sql)
  return { getDb: () => sql }
})
import refreshHandler from '../server/api/official/refresh.post'

const checkedAt = '2026-10-04T04:00:00.000Z'
function model(id: string, included: boolean | null, endpoints: OfficialCatalogModel['supportedEndpoints'] = ['chat/completions']): OfficialCatalogModel {
  return { id, name: id, providerAvailable: true, supportedEndpoints: endpoints, contextLength: null, minPlanName: null, vendor: null, category: null,
    planAccess: { goat: { included, apiAccess: true, allowanceUsd: null, paygEligible: null, source: 'official-goat', apiSource: 'official-provider', allowanceSource: null, paygSource: null, checkedAt } }, sources: ['official-goat', 'official-provider'] }
}
function catalog(): OfficialCatalogView {
  return { models: [model('goat/model', true), model('premium/model', false), model('unconfirmed/alias', null), model('unsupported/protocol', true, [])],
    plans: [{ id: 'goat', name: 'GOAT', price: null, credits: null, modelDescription: null, apiAccess: true, apiSource: 'official-provider', includedModelCount: 2, scope: 'explicit', source: 'official-goat', checkedAt }],
    sources: ['goat', 'provider-models', 'provider'].map(id => ({ id, url: `https://commandcode.ai/${id}`, fetchedAt: checkedAt, lastAttemptAt: checkedAt, etag: null, lastModified: null, error: null, modelCount: null })), fetchedAt: checkedAt, lastAttemptAt: checkedAt, stale: false, error: null }
}

describe('manual official refresh through real HTTP', () => {
  let server: Server, url: string
  beforeEach(async () => {
    vi.clearAllMocks(); fixture.authorized = true; fixture.catalog = catalog(); fixture.previous = catalog(); fixture.rows.clear(); fixture.sqlCalls = []
    fixture.rows.set('old/model', {}); fixture.rows.set('premium/model', {})
    fixture.sync.mockImplementation(async () => fixture.catalog)
    fixture.bridge.mockImplementation(async () => { expect([...fixture.rows.keys()]).toEqual(fixture.catalog!.models.filter(row => row.planAccess.goat?.included === true && row.supportedEndpoints.length).map(row => row.id)) })
    const app = createApp(); app.use(refreshHandler)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) })
  it('updates the real selectable model table and managed bridge before replying while retaining excluded audit entries', async () => {
    const response = await fetch(url + '/api/official/refresh', { method: 'POST' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.models).toHaveLength(4)
    expect(body.availabilitySync).toMatchObject({ modelCount: 1, bridgeUpdated: true, bridgeError: null })
    expect([...fixture.rows.keys()]).toEqual(['goat/model'])
    expect(fixture.sync).toHaveBeenCalledExactlyOnceWith(true)
    expect(fixture.cache).toHaveBeenCalledWith('ccm:catalog:updatedAt', checkedAt)
    expect(fixture.publish).toHaveBeenCalledWith({ type: 'models' })
    expect(fixture.bridge).toHaveBeenCalledOnce()
  })
  it('persists a trusted empty scope and synchronously clears obsolete bridge inventory', async () => {
    fixture.catalog!.models = fixture.catalog!.models.map(row => ({ ...row, planAccess: { goat: { ...row.planAccess.goat!, included: false } } }))
    fixture.catalog!.plans[0]!.includedModelCount = 0
    const response = await fetch(url, { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await response.json()).availabilitySync.modelCount).toBe(0)
    expect(fixture.rows.size).toBe(0)
    expect(fixture.bridge).toHaveBeenCalledOnce()
  })
  it('leaves the previous model table intact when the required subscription source has never loaded', async () => {
    fixture.catalog!.sources.find(source => source.id === 'goat')!.fetchedAt = null
    const response = await fetch(url, { method: 'POST' })
    expect(response.status).toBe(503)
    expect([...fixture.rows.keys()]).toEqual(['old/model','premium/model'])
    expect(fixture.sqlCalls).toEqual([])
    expect(fixture.bridge).not.toHaveBeenCalled()
  })
  it('reports another active refresh without overwriting new worker availability with its old cached snapshot', async () => {
    fixture.catalog!.refreshInProgress = true
    const response = await fetch(url, { method: 'POST' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.refreshInProgress).toBe(true)
    expect(body.availabilitySync).toBeUndefined()
    expect([...fixture.rows.keys()]).toEqual(['old/model','premium/model'])
    expect(fixture.sqlCalls).toEqual([])
    expect(fixture.bridge).not.toHaveBeenCalled()
  })
  it('reports a bridge sync failure separately without undoing valid official availability or leaking details', async () => {
    fixture.bridge.mockRejectedValue(new Error('private-core-credential-for-tests'))
    const response = await fetch(url, { method: 'POST' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.availabilitySync).toMatchObject({ modelCount: 1, bridgeUpdated: false })
    expect(body.availabilitySync.bridgeError).toContain('渠道暂未同步')
    expect(JSON.stringify(body)).not.toContain('private-core-credential-for-tests')
    expect([...fixture.rows.keys()]).toEqual(['goat/model'])
  })
  it('requires an admin session before fetching sources or changing inventory', async () => {
    fixture.authorized = false
    expect((await fetch(url, { method: 'POST' })).status).toBe(401)
    expect(fixture.sync).not.toHaveBeenCalled()
    expect(fixture.sqlCalls).toEqual([])
  })
})
