import { createDevin2ApiClient, type Devin2ApiClient } from './client'
import { listDevin2ApiAccounts, type Devin2ApiAccount } from './accounts'
import { getDevin2ApiRuntime } from './runtime'

export interface Devin2ApiModel { id: string; object: 'model'; owned_by?: string; display_name?: string; [key: string]: unknown }
type JsonObject = Record<string, unknown>
const asObject = (value: unknown): JsonObject | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
const asText = (value: unknown) => typeof value === 'string' ? value.trim() : ''
function normalizeModel(value: unknown): Devin2ApiModel | null {
  const item = asObject(value); const id = asText(item?.id)
  if (!id || id.length > 256 || id.includes('\\') || id.startsWith('devin/')) return null
  const model: Devin2ApiModel = { id, object: 'model' }
  const ownedBy = asText(item?.owned_by || item?.ownedBy); const displayName = asText(item?.display_name || item?.displayName || item?.name)
  if (ownedBy) model.owned_by = ownedBy; if (displayName) model.display_name = displayName
  return model
}
export function parseDevin2ApiModels(payload: unknown): Devin2ApiModel[] {
  const object = asObject(payload)
  const raw = Array.isArray(object?.data) ? object.data : Array.isArray(object?.models) ? object.models : Array.isArray(object?.items) ? object.items : Array.isArray(payload) ? payload : []
  const byId = new Map<string, Devin2ApiModel>()
  for (const item of raw) { const model = normalizeModel(item); if (model) { const previous = byId.get(model.id); byId.set(model.id, previous ? { ...model, ...previous } : model) } }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}
export function namespaceDevin2ApiModel(model: Devin2ApiModel): Devin2ApiModel { return { ...model, id: 'devin/' + model.id } }
export function namespaceDevin2ApiModels(models: Devin2ApiModel[]): Devin2ApiModel[] { return models.map(namespaceDevin2ApiModel) }
export function isDevin2ApiModel(model: string): boolean { return /^devin\/[^/\\\s]+(?:\/[^/\\\s]+)*$/.test(model.trim()) }
export function stripDevin2ApiModel(model: string): string | null { const value = model.trim(); if (!isDevin2ApiModel(value)) return null; return value.slice('devin/'.length) || null }

let cache: { models: Devin2ApiModel[]; expiresAt: number; key: string } | undefined
const pending = new Map<string, Promise<Devin2ApiModel[]>>()
export function resetDevin2ApiCatalog() { cache = undefined; pending.clear() }
function accountRuntimeConfig(account: Devin2ApiAccount) {
  return { id: account.id, baseUrl: account.baseUrl, model: account.model, proxy: account.proxy, maxConcurrency: (account as Devin2ApiAccount & { maxConcurrency?: number }).maxConcurrency || 2 }
}
async function loadAccountModels(account: Devin2ApiAccount): Promise<Devin2ApiModel[]> {
  const endpoint = await getDevin2ApiRuntime(accountRuntimeConfig(account))
  const client = createDevin2ApiClient(endpoint)
  const response = await client.listModels()
  if (!response.ok) throw Object.assign(new Error(`Devin runtime model catalog returned HTTP ${response.status}`), { statusCode: 502 })
  let payload: unknown; try { payload = await response.json() } catch { throw Object.assign(new Error('Devin runtime model catalog is not valid JSON'), { statusCode: 502 }) }
  return parseDevin2ApiModels(payload)
}
export async function listDevin2ApiModels(options: { client?: Devin2ApiClient; fresh?: boolean; accounts?: Devin2ApiAccount[]; accountIds?: string[] } = {}): Promise<Devin2ApiModel[]> {
  if (options.client) {
    const response = await options.client.listModels()
    if (!response.ok) throw Object.assign(new Error(`Devin runtime model catalog returned HTTP ${response.status}`), { statusCode: 502 })
    return parseDevin2ApiModels(await response.json())
  }
  const accounts = (options.accounts || await listDevin2ApiAccounts()).filter(account => account.enabled && ['pending', 'ready'].includes(account.status) && account.hasToken && (!options.accountIds || options.accountIds.includes(account.id)))
  const key = accounts.map(a => a.id).sort().join(',')
  const now = Date.now()
  if (!options.fresh && cache && cache.expiresAt > now && cache.key === key) return cache.models.map(model => ({ ...model }))
  if (!options.fresh && pending.has(key)) return pending.get(key)!.then(models => models.map(model => ({ ...model })))
  const load = (async () => {
    const all = new Map<string, Devin2ApiModel>(); let firstError: unknown
    for (const account of accounts) {
      try { for (const model of await loadAccountModels(account)) { const previous = all.get(model.id); all.set(model.id, previous ? { ...model, ...previous } : model) } }
      catch (error) { firstError ??= error }
    }
    if (!all.size && firstError) throw firstError
    const models = [...all.values()].sort((a, b) => a.id.localeCompare(b.id)); cache = { models, expiresAt: Date.now() + 15_000, key }; return models
  })()
  if (!options.fresh) pending.set(key, load)
  try { return (await load).map(model => ({ ...model })) } finally { if (pending.get(key) === load) pending.delete(key) }
}
export async function listNamespacedDevin2ApiModels(options: Parameters<typeof listDevin2ApiModels>[0] = {}) { return namespaceDevin2ApiModels(await listDevin2ApiModels(options)) }
export async function hasDevin2ApiModel(model: string, options: Parameters<typeof listDevin2ApiModels>[0] = {}) { const id = stripDevin2ApiModel(model); return !!id && (await listDevin2ApiModels(options)).some(item => item.id === id) }
