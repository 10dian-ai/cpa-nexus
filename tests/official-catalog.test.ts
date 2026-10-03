import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { OfficialCatalogView } from '../shared/official-catalog'
import { decodeDocumentRecords, parseOfficialDocument, parseProviderModels, parseWebsiteModels } from '../server/lib/official-catalog/parser'
import { buildCatalog, fetchOfficialSource, OFFICIAL_SOURCES, OfficialCatalogService, shouldRefresh, type CatalogStore, type SourceState } from '../server/lib/official-catalog/service'
import { OfficialCatalogUnavailableError, resolveProviderModel } from '../server/lib/official-catalog'

const NOW = Date.parse('2026-10-03T06:00:00Z')
const fixture = (name: string) => readFileSync(new URL('./fixtures/official-catalog/' + name, import.meta.url), 'utf8')
function successfulSources(): SourceState[] {
  return OFFICIAL_SOURCES.map(definition => {
    const payload = definition.kind === 'provider-models' ? parseProviderModels(fixture('provider-models.json')) : definition.kind === 'website-models' ? parseWebsiteModels(fixture('models.html')) : parseOfficialDocument(fixture(definition.kind + '.html'), definition.kind)
    return { id: definition.id, url: definition.url, payload, fetchedAt: new Date(NOW).toISOString(), lastAttemptAt: new Date(NOW).toISOString(), etag: '"revision-1"', lastModified: null, error: null, modelCount: payload.providerModels.length || payload.models.length || payload.scope?.length || null }
  })
}
function memoryStore(initial: SourceState[] = []): CatalogStore & { sources: SourceState[]; snapshot: OfficialCatalogView | null } {
  let locked = false
  return {
    sources: initial, snapshot: initial.length ? buildCatalog(initial, NOW) : null,
    async readSources() { return this.sources.map(source => ({ ...source })) },
    async saveSource(source) { const index = this.sources.findIndex(row => row.id === source.id); if (index >= 0) this.sources[index] = source; else this.sources.push(source) },
    async readSnapshot() { return this.snapshot }, async saveSnapshot(view) { this.snapshot = view },
    async readCache() { return this.snapshot }, async saveCache(view) { this.snapshot = view },
    async acquireLock() { if (locked) return false; locked = true; return true }, async releaseLock() { locked = false },
  }
}

describe('real public official catalog markup', () => {
  it('decodes official model IDs from React Router loader data', () => {
    const models = parseWebsiteModels(fixture('models.html')).models
    expect(models).toHaveLength(86)
    expect(models.find(model => model.id === 'moonshotai/Kimi-K3')).toMatchObject({ name: 'Kimi K3', minPlanName: 'Go' })
    expect(models.find(model => model.id === 'claude-opus-5-5')?.minPlanName).toBe('Max')
  })
  it('joins split Next.js records and reads complete subscription ID scopes', () => {
    expect(decodeDocumentRecords(fixture('goat.html'))).toHaveLength(1)
    expect(parseOfficialDocument(fixture('go.html'), 'go').scope).toHaveLength(53)
    expect(parseOfficialDocument(fixture('goat.html'), 'goat').scope).toHaveLength(63)
    expect(parseOfficialDocument(fixture('pro.html'), 'pro').scope).toHaveLength(77)
  })
  it('uses exact Provider API protocol lists rather than model-name guesses', () => {
    const models = parseProviderModels(fixture('provider-models.json')).providerModels
    expect(models).toHaveLength(85)
    expect(models.find(model => model.id === 'claude-sonnet-5-5')?.supportedEndpoints).toEqual(['messages'])
    expect(models.find(model => model.id === 'gpt-6-astra')?.supportedEndpoints).toEqual(['chat/completions', 'responses'])
    expect(models.find(model => model.id === 'deepseek/deepseek-v4-flash-fast')?.supportedEndpoints).toEqual(['chat/completions'])
  })
  it('preserves unknown team scope, allowances and extra-credit eligibility separately', () => {
    const view = buildCatalog(successfulSources(), NOW)
    expect(view.plans).toHaveLength(8)
    expect(view.plans.find(plan => plan.id === 'goat')).toMatchObject({ price: '$10', credits: '$70', includedModelCount: 63, scope: 'explicit', apiAccess: true })
    expect(view.plans.find(plan => plan.id === 'go')).toMatchObject({ apiAccess: false })
    expect(view.models.find(model => model.id === 'claude-opus-5-5')?.planAccess.goat).toMatchObject({ included: false, apiAccess: true, paygEligible: true })
    expect(view.models.find(model => model.id === 'claude-opus-5-5')?.planAccess.team).toMatchObject({ included: null, apiAccess: true })
    expect(view.models.find(model => model.id === 'tencent/hy3-paid')?.planAccess.goat?.allowanceUsd).toBe(70)
    expect(view.models.filter(model => model.providerAvailable)).toHaveLength(86)
    expect(view.models.filter(model => model.apiCatalogListed)).toHaveLength(85)
    expect(view.models.some(model => !model.providerAvailable && model.supportedEndpoints.length === 0)).toBe(true)
    expect(view.models.find(model => model.id === 'claude-haiku-4-5-20251001')?.planAccess.goat?.included).toBeNull()
    expect(view.stale).toBe(false)
  })
  it('binds documented Systemone support to the exact official request model, including text-length frames', () => {
    const page = parseOfficialDocument(fixture('provider-systemone.html'), 'provider')
    expect(page.documentedProviderModels).toEqual([{ id: 'typesafe/jev', supportedEndpoints: ['systemone'] }])
    const view = buildCatalog(successfulSources(), NOW)
    expect(resolveProviderModel(view, 'typesafe/jev')).toMatchObject({ apiCatalogListed: false, apiDocumented: true, providerAvailable: true, supportedEndpoints: ['systemone'] })
    expect(resolveProviderModel(view, 'typesafe/jev')?.sources).toContain('https://commandcode.ai/docs/provider')
    expect(view.sources.find(source => source.id === 'provider-models')?.modelCount).toBe(85)
  })
  it('does not grant Systemone support when the official example is missing or changes endpoint', () => {
    const sources = successfulSources(); const provider = sources.find(source => source.id === 'provider')!
    provider.payload = parseOfficialDocument(fixture('provider.html').replaceAll('/systemone', '/unknown-endpoint'), 'provider')
    expect(provider.payload.documentedProviderModels).toEqual([])
    expect(resolveProviderModel(buildCatalog(sources, NOW), 'typesafe/jev')).toBeNull()
    provider.payload.documentedProviderModels = [{ id: 'unpublished/example', supportedEndpoints: ['systemone'] }]
    expect(resolveProviderModel(buildCatalog(sources, NOW), 'unpublished/example')).toBeNull()
  })
  it('serves explicit documented support before the public list loads but keeps unknown IDs unavailable', () => {
    const sources = successfulSources().filter(source => source.id !== 'provider-models')
    const view = buildCatalog(sources, NOW)
    expect(resolveProviderModel(view, 'typesafe/jev')?.supportedEndpoints).toEqual(['systemone'])
    expect(() => resolveProviderModel(view, 'gpt-6-astra')).toThrow(OfficialCatalogUnavailableError)
    expect(resolveProviderModel(buildCatalog(successfulSources(), NOW), 'unknown/model')).toBeNull()
  })
  it.each([
    ['empty provider array', () => parseProviderModels('{"object":"list","data":[]}')],
    ['truncated provider JSON', () => parseProviderModels(fixture('provider-models.json').slice(0, -30))],
    ['missing endpoint metadata', () => parseProviderModels('{"object":"list","data":[{"id":"claude-opus-5-5","name":"Claude"}]}')],
    ['wrong loader markup', () => parseWebsiteModels('<html><table>Claude</table></html>')],
    ['truncated loader', () => parseWebsiteModels(fixture('models.html').slice(0, -200))],
    ['wrong subscription markup', () => parseOfficialDocument('<html>GOAT has every model</html>', 'goat')],
    ['empty scope', () => parseOfficialDocument('<script>self.__next_f.push([1,"0:{\\"planScope\\":{\\"label\\":\\"GOAT plan\\",\\"modelIds\\":[]}}\\n"])</script>', 'goat')],
  ])('rejects %s without inventing or emptying a catalog', (_, parse) => expect(parse).toThrow())
})

describe('resource bounded official refresh', () => {
  const definition = OFFICIAL_SOURCES[0]!
  it('uses conditional GET and keeps data on 304', async () => {
    const previous = successfulSources()[0]!
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      expect(options?.headers).toMatchObject({ 'if-none-match': '"revision-1"' })
      expect((options?.headers as Record<string, string>).authorization).toBeUndefined()
      return new Response(null, { status: 304 })
    })
    const result = await fetchOfficialSource(definition, previous, { fetch: fetcher as typeof fetch, now: () => NOW + 300_000 })
    expect(result.payload).toEqual(previous.payload)
    expect(result.fetchedAt).toBe(new Date(NOW + 300_000).toISOString())
    expect(result.error).toBeNull()
  })
  it('retains last good model snapshot and validators after malformed upstream data', async () => {
    const previous = successfulSources()[0]!
    const result = await fetchOfficialSource(definition, previous, { fetch: (async () => new Response('{"object":"list","data":[]}')) as typeof fetch, now: () => NOW + 300_000 })
    expect(result.payload).toEqual(previous.payload)
    expect(result.fetchedAt).toBe(previous.fetchedAt)
    expect(result.etag).toBe(previous.etag)
    expect(result.lastAttemptAt).toBe(new Date(NOW + 300_000).toISOString())
    expect(result.error).toContain('empty')
  })
  it('bounds response size even when Content-Length is absent', async () => {
    const result = await fetchOfficialSource(definition, undefined, { fetch: (async () => new Response('x'.repeat(100))) as typeof fetch, maxBytes: 50 })
    expect(result.payload).toBeNull()
    expect(result.error).toContain('size limit')
  })
  it('bounds a stalled fetch implementation', async () => {
    const result = await fetchOfficialSource(definition, undefined, { fetch: (() => new Promise<Response>(() => {})) as typeof fetch, timeoutMs: 10 })
    expect(result.error).toContain('timed out')
  })
  it('bounds a stalled streaming response body', async () => {
    const result = await fetchOfficialSource(definition, undefined, { fetch: (async () => new Response(new ReadableStream())) as typeof fetch, timeoutMs: 10 })
    expect(result.error).toContain('timed out')
  })
  it('does not accept 304 when there is no good snapshot', async () => {
    const result = await fetchOfficialSource(definition, undefined, { fetch: (async () => new Response(null, { status: 304 })) as typeof fetch })
    expect(result.error).toContain('without a previous')
  })
  it('distinguishes 5 minute API and 15 minute website schedules', () => {
    const sources = successfulSources()
    expect(shouldRefresh(sources, NOW + 299_999)).toBe(false)
    expect(shouldRefresh(sources, NOW + 300_000)).toBe(true)
  })
  it('shares concurrent refresh work and uses a distributed lock', async () => {
    const store = memoryStore(successfulSources()); let resolve!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done }))
    const first = new OfficialCatalogService(store, { fetch: fetcher as typeof fetch, now: () => NOW + 300_000 })
    const second = new OfficialCatalogService(store, { fetch: fetcher as typeof fetch, now: () => NOW + 300_000 })
    const pending = first.sync(); const shared = first.sync()
    expect(shared).toBe(pending)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    await second.sync()
    expect(fetcher).toHaveBeenCalledOnce()
    resolve(new Response(null, { status: 304 })); await pending
  })
  it('serves durable last good snapshot when Redis cache fails', async () => {
    const store = memoryStore(successfulSources()); store.readCache = async () => { throw new Error('Redis temporarily unavailable') }
    const view = await new OfficialCatalogService(store, { now: () => NOW + 900_001 }).getCatalog()
    expect(view.models).toHaveLength(87)
    expect(view.stale).toBe(true)
  })
  it('repopulates expired cache from PostgreSQL without a new external request', async () => {
    const store = memoryStore(successfulSources())
    store.readCache = async () => null
    const save = vi.spyOn(store, 'saveCache')
    const fetcher = vi.fn()
    const view = await new OfficialCatalogService(store, { fetch: fetcher as typeof fetch, now: () => NOW }).getCatalog()
    expect(view.models).toHaveLength(87)
    expect(save).toHaveBeenCalledOnce()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('shares short-lived in-process reads for concurrent gateway calls', async () => {
    const store = memoryStore(successfulSources()); const read = vi.spyOn(store, 'readCache')
    let now = NOW
    const service = new OfficialCatalogService(store, { now: () => now })
    await Promise.all(Array.from({ length: 30 }, () => service.getCatalog()))
    expect(read).toHaveBeenCalledOnce()
    await service.getCatalog(); expect(read).toHaveBeenCalledOnce()
    now += 5000; await service.getCatalog(); expect(read).toHaveBeenCalledTimes(2)
  })
  it('retains previous sources on refresh failure and exposes the error', async () => {
    const store = memoryStore(successfulSources())
    const service = new OfficialCatalogService(store, { fetch: (async () => new Response('unavailable', { status: 503 })) as typeof fetch, now: () => NOW + 900_000 })
    const view = await service.sync()
    expect(view.models).toHaveLength(87)
    expect(view.plans.find(plan => plan.id === 'goat')?.includedModelCount).toBe(63)
    expect(view.stale).toBe(true)
    expect(view.error).toContain('HTTP 503')
  })
  it('limits manual refresh bursts and avoids website polling on the API schedule', async () => {
    const store = memoryStore(successfulSources()); let now = NOW + 300_000
    const fetcher = vi.fn(async () => new Response(null, { status: 304 }))
    const service = new OfficialCatalogService(store, { fetch: fetcher as typeof fetch, now: () => now })
    await service.sync(); expect(fetcher).toHaveBeenCalledTimes(1)
    now += 1; await service.sync(); expect(fetcher).toHaveBeenCalledTimes(1)
    await service.sync(true); expect(fetcher).toHaveBeenCalledTimes(8)
    await service.sync(true); expect(fetcher).toHaveBeenCalledTimes(8)
  })
})
