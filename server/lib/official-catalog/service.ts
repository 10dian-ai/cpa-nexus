import { randomUUID } from 'node:crypto'
import type { OfficialCatalogModel, OfficialCatalogPlan, OfficialCatalogSource, OfficialCatalogView, OfficialPlanAccess } from '../../../shared/official-catalog'
import { parseOfficialDocument, parseProviderModels, parseWebsiteModels, type ParsedPage } from './parser'

export const OFFICIAL_SOURCES = [
  { id: 'provider-models', url: 'https://api.commandcode.ai/provider/v1/models', intervalMs: 5 * 60_000, kind: 'provider-models' },
  { id: 'website-models', url: 'https://commandcode.ai/models', intervalMs: 15 * 60_000, kind: 'website-models' },
  { id: 'pricing', url: 'https://commandcode.ai/docs/resources/pricing-limits', intervalMs: 15 * 60_000, kind: 'pricing' },
  { id: 'go', url: 'https://commandcode.ai/docs/plans/go', intervalMs: 15 * 60_000, kind: 'go' },
  { id: 'goat', url: 'https://commandcode.ai/docs/plans/goat', intervalMs: 15 * 60_000, kind: 'goat' },
  { id: 'pro', url: 'https://commandcode.ai/docs/plans/pro', intervalMs: 15 * 60_000, kind: 'pro' },
  { id: 'max', url: 'https://commandcode.ai/docs/plans/max', intervalMs: 15 * 60_000, kind: 'max' },
  { id: 'provider', url: 'https://commandcode.ai/docs/provider', intervalMs: 15 * 60_000, kind: 'provider' },
] as const
export interface SourceState extends OfficialCatalogSource { payload: ParsedPage | null }
export interface CatalogStore {
  readSources(): Promise<SourceState[]>
  saveSource(source: SourceState): Promise<void>
  readSnapshot(): Promise<OfficialCatalogView | null>
  saveSnapshot(view: OfficialCatalogView): Promise<void>
  readCache(): Promise<OfficialCatalogView | null>
  saveCache(view: OfficialCatalogView): Promise<void>
  acquireLock(token: string): Promise<boolean>
  releaseLock(token: string): Promise<void>
}
export interface CatalogOptions { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; maxBytes?: number }
const timestamp = (value: string | null) => value ? Date.parse(value) : 0
const unknownAccess = (): OfficialPlanAccess => ({ included: null, apiAccess: null, allowanceUsd: null, paygEligible: null, source: null, apiSource: null, allowanceSource: null, paygSource: null, checkedAt: null })
export function shouldRefresh(sources: Pick<OfficialCatalogSource, 'id' | 'lastAttemptAt'>[], now = Date.now()): boolean {
  return OFFICIAL_SOURCES.some(definition => now - timestamp(sources.find(source => source.id === definition.id)?.lastAttemptAt || null) >= definition.intervalMs)
}
export function withFreshness(view: OfficialCatalogView, now: number): OfficialCatalogView {
  const stale = !view.fetchedAt || OFFICIAL_SOURCES.some(definition => {
    const source = view.sources.find(item => item.id === definition.id)
    return !source?.fetchedAt || !!source.error || now - timestamp(source.fetchedAt) > definition.intervalMs + 30_000
  })
  return { ...view, stale }
}

export function buildCatalog(sources: SourceState[], now = Date.now()): OfficialCatalogView {
  const source = (id: string) => sources.find(item => item.id === id)
  const website = source('website-models'); const provider = source('provider-models'); const pricing = source('pricing')
  const providerDoc = source('provider'); const max = source('max')
  const plans: OfficialCatalogPlan[] = (pricing?.payload?.plans || []).map(plan => {
    const detail = source(plan.id)
    const scope = detail?.payload?.scope
    const all = (['max10', 'max20'].includes(plan.id) && max?.payload?.allModels === true) || (plan.id === 'provider' && pricing?.payload?.paygAllModels === true)
    const scopeSource = scope ? detail : all ? (plan.id === 'provider' ? pricing : max) : pricing
    const apiAccess = providerDoc?.payload?.apiAccessExceptGo && plan.id !== 'enterprise' ? plan.id !== 'go' : null
    return { ...plan, apiAccess, apiSource: apiAccess === null ? null : providerDoc!.url, scope: scope ? 'explicit' : all ? 'all' : 'unknown', includedModelCount: scope ? scope.length : all ? website?.payload?.models.length || provider?.payload?.providerModels.length || null : null, source: scopeSource!.url, checkedAt: scopeSource!.fetchedAt! }
  })
  const byId = new Map<string, OfficialCatalogModel>()
  for (const model of website?.payload?.models || []) byId.set(model.id, { ...model, providerAvailable: false, apiCatalogListed: false, apiDocumented: false, supportedEndpoints: [], planAccess: {}, sources: [website!.url] })
  for (const model of provider?.payload?.providerModels || []) {
    const existing = byId.get(model.id)
    byId.set(model.id, { id: model.id, name: model.name, contextLength: model.contextLength, minPlanName: existing?.minPlanName || null, vendor: existing?.vendor || null, category: existing?.category || null, providerAvailable: model.supportedEndpoints.length > 0, apiCatalogListed: true, apiDocumented: false, supportedEndpoints: model.supportedEndpoints, planAccess: {}, sources: [...(existing?.sources || []), provider!.url] })
  }
  for (const documented of providerDoc?.payload?.documentedProviderModels || []) {
    // Require a matching official catalog ID as well as the exact documented request example.
    const model = byId.get(documented.id)
    if (!model) continue
    model.apiDocumented = true; model.providerAvailable = true
    model.supportedEndpoints = [...new Set([...model.supportedEndpoints, ...documented.supportedEndpoints])]
    if (!model.sources.includes(providerDoc!.url)) model.sources.push(providerDoc!.url)
  }
  for (const model of byId.values()) for (const plan of plans) {
    const detail = source(plan.id); const scope = detail?.payload?.scope; const access = unknownAccess()
    if (scope) {
      // A public API alias absent from the website is not proof of a subscription exclusion.
      // Keep its scope unknown until the official page publishes that exact ID.
      access.included = scope.includes(model.id) ? true : model.sources.includes(website?.url || '') ? false : null
      access.source = detail!.url; access.checkedAt = detail!.fetchedAt
    }
    else if (plan.scope === 'all') { access.included = true; access.source = plan.source; access.checkedAt = plan.checkedAt }
    access.apiAccess = plan.apiAccess
    access.apiSource = plan.apiSource
    access.paygEligible = pricing?.payload?.paygAllModels || max?.payload?.paygAllModels ? true : null
    access.paygSource = pricing?.payload?.paygAllModels ? pricing.url : max?.payload?.paygAllModels ? max.url : null
    const allowance = pricing?.payload?.allowances[model.id]?.[plan.id]
    if (typeof allowance === 'number') { access.allowanceUsd = allowance; access.allowanceSource = pricing!.url }
    model.planAccess[plan.id] = access
  }
  // Count each plan's included models directly, never subtract one class from another.
  for (const plan of plans) if (plan.scope !== 'unknown') plan.includedModelCount = [...byId.values()].filter(model => model.planAccess[plan.id]?.included === true).length
  const dates = sources.map(item => item.fetchedAt).filter((date): date is string => !!date)
  const attempts = sources.map(item => item.lastAttemptAt).filter((date): date is string => !!date)
  const errors = sources.filter(item => item.error).map(item => `${item.id}: ${item.error}`)
  return withFreshness({ models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), plans,
    fetchedAt: dates.length ? dates.sort()[0]! : null, lastAttemptAt: attempts.length ? attempts.sort().at(-1)! : null,
    stale: true, error: errors.length ? errors.join('; ') : null,
    sources: OFFICIAL_SOURCES.map(definition => { const row = source(definition.id); return { id: definition.id, url: definition.url, fetchedAt: row?.fetchedAt || null, lastAttemptAt: row?.lastAttemptAt || null, etag: row?.etag || null, lastModified: row?.lastModified || null, error: row?.error || null, modelCount: row?.modelCount ?? null } }),
  }, now)
}

/** An individual response's deadline also covers consuming a stalled response body. */
export async function fetchOfficialSource(definition: typeof OFFICIAL_SOURCES[number], previous: SourceState | undefined, options: CatalogOptions): Promise<SourceState> {
  const now = options.now || Date.now; const attempted = new Date(now()).toISOString()
  const state: SourceState = previous ? { ...previous, lastAttemptAt: attempted } : { id: definition.id, url: definition.url, payload: null, fetchedAt: null, lastAttemptAt: attempted, etag: null, lastModified: null, error: null, modelCount: null }
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error('Official source request timed out')), options.timeoutMs || 15_000)
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Official source request timed out')), { once: true }))
  const maxBytes = options.maxBytes || 2 * 1024 * 1024
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const headers: Record<string, string> = { accept: definition.kind === 'provider-models' ? 'application/json' : 'text/html', 'user-agent': 'CPA-Nexus/0.2 public-catalog-sync' }
    if (previous?.etag) headers['if-none-match'] = previous.etag
    if (previous?.lastModified) headers['if-modified-since'] = previous.lastModified
    const response = await Promise.race([(options.fetch || fetch)(definition.url, { headers, signal: controller.signal, redirect: 'error' }), deadline])
    if (response.status === 304) {
      if (!previous?.payload) throw new Error('Received 304 without a previous valid snapshot')
      return { ...state, fetchedAt: attempted, error: null }
    }
    if (!response.ok) throw new Error('Official source returned HTTP ' + response.status)
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Official source exceeds size limit')
    if (!response.body) throw new Error('Official source body is empty')
    reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = []
    while (true) {
      const result = await Promise.race([reader.read(), deadline])
      if (controller.signal.aborted) throw new Error('Official source request timed out')
      if (result.done) break
      bytes += result.value.length
      if (bytes > maxBytes) throw new Error('Official source exceeds size limit')
      chunks.push(result.value)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const payload = definition.kind === 'provider-models' ? parseProviderModels(text) : definition.kind === 'website-models' ? parseWebsiteModels(text) : parseOfficialDocument(text, definition.kind)
    const modelCount = definition.kind === 'provider-models' ? payload.providerModels.length : definition.kind === 'website-models' ? payload.models.length : payload.scope?.length ?? null
    return { ...state, payload, fetchedAt: attempted, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), error: null, modelCount }
  } catch (error) {
    return { ...state, error: controller.signal.aborted ? 'Official source request timed out' : error instanceof Error ? error.message.slice(0, 300) : 'Official source refresh failed' }
  } finally { clearTimeout(timeout); await reader?.cancel().catch(() => {}) }
}

export class OfficialCatalogService {
  private pending: Promise<OfficialCatalogView> | undefined
  private pendingForced = false
  private queuedForce: Promise<OfficialCatalogView> | undefined
  private pendingRead: Promise<OfficialCatalogView> | undefined
  private local: { until: number; view: OfficialCatalogView } | undefined
  constructor(private store: CatalogStore, private options: CatalogOptions = {}) {}
  async getCatalog(): Promise<OfficialCatalogView> {
    if (this.local && this.time() < this.local.until) return withFreshness(this.local.view, this.time())
    if (this.pendingRead) return this.pendingRead
    this.pendingRead = this.readCatalog().finally(() => { this.pendingRead = undefined })
    return this.pendingRead
  }
  private async readCatalog(): Promise<OfficialCatalogView> {
    const cached = await this.store.readCache().catch(() => null)
    const snapshot = cached || await this.store.readSnapshot()
    if (!cached && snapshot) await this.store.saveCache(snapshot).catch(() => {})
    const view = withFreshness(snapshot || buildCatalog([], this.time()), this.time())
    this.local = { until: this.time() + 5000, view }
    return view
  }
  sync(force = false): Promise<OfficialCatalogView> {
    if (this.pending) {
      if (force && !this.pendingForced) {
        if (!this.queuedForce) this.queuedForce = this.pending.then(() => this.sync(true)).finally(() => { this.queuedForce = undefined })
        return this.queuedForce
      }
      return this.pending
    }
    this.pendingForced = force
    this.pending = this.refresh(force).finally(() => { this.pending = undefined; this.pendingForced = false })
    return this.pending
  }
  private time() { return (this.options.now || Date.now)() }
  private async refresh(force: boolean): Promise<OfficialCatalogView> {
    const token = randomUUID()
    if (!await this.store.acquireLock(token)) return { ...await this.getCatalog(), refreshInProgress: true }
    try {
      const sources = await this.store.readSources(); const now = this.time()
      const due = OFFICIAL_SOURCES.filter(definition => {
        const previous = sources.find(source => source.id === definition.id)
        return now - timestamp(previous?.lastAttemptAt || null) >= (force ? 30_000 : definition.intervalMs)
      })
      if (!due.length) return this.getCatalog()
      const updated = await Promise.all(due.map(definition => fetchOfficialSource(definition, sources.find(source => source.id === definition.id), this.options)))
      for (const row of updated) { await this.store.saveSource(row); const index = sources.findIndex(source => source.id === row.id); if (index >= 0) sources[index] = row; else sources.push(row) }
      const view = buildCatalog(sources, this.time())
      await this.store.saveSnapshot(view); await this.store.saveCache(view).catch(() => {})
      this.local = { until: this.time() + 5000, view }
      return view
    } finally { await this.store.releaseLock(token).catch(() => {}) }
  }
}
