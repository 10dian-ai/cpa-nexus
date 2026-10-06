import { createDevin2ApiClient, type Devin2ApiClient } from './client'

export interface Devin2ApiModel {
  id: string
  object: 'model'
  owned_by?: string
  display_name?: string
  [key: string]: unknown
}

type JsonObject = Record<string, unknown>
const asObject = (value: unknown): JsonObject | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
const asText = (value: unknown) => typeof value === 'string' ? value.trim() : ''

function normalizeModel(value: unknown): Devin2ApiModel | null {
  const item = asObject(value)
  const id = asText(item?.id)
  if (!id || id.length > 256 || id.includes('\\') || id.startsWith('devin/')) return null
  const model: Devin2ApiModel = { id, object: 'model' }
  const ownedBy = asText(item?.owned_by || item?.ownedBy)
  const displayName = asText(item?.display_name || item?.displayName || item?.name)
  if (ownedBy) model.owned_by = ownedBy
  if (displayName) model.display_name = displayName
  return model
}

export function parseDevin2ApiModels(payload: unknown): Devin2ApiModel[] {
  const object = asObject(payload)
  const raw = Array.isArray(object?.data) ? object.data : Array.isArray(object?.models) ? object.models : Array.isArray(object?.items) ? object.items : Array.isArray(payload) ? payload : []
  const byId = new Map<string, Devin2ApiModel>()
  for (const item of raw) {
    const model = normalizeModel(item)
    if (model) {
      const previous = byId.get(model.id)
      // Deduplicate by ID while retaining metadata from whichever catalog
      // entry is richer (sidecars occasionally emit duplicate bare records).
      byId.set(model.id, previous ? { ...model, ...previous } : model)
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function namespaceDevin2ApiModel(model: Devin2ApiModel): Devin2ApiModel {
  return { ...model, id: 'devin/' + model.id }
}
export function namespaceDevin2ApiModels(models: Devin2ApiModel[]): Devin2ApiModel[] { return models.map(namespaceDevin2ApiModel) }
export function isDevin2ApiModel(model: string): boolean { return /^devin\/[^/\\\s]+(?:\/[^/\\\s]+)*$/.test(model.trim()) }
export function stripDevin2ApiModel(model: string): string | null {
  const value = model.trim()
  if (!isDevin2ApiModel(value)) return null
  const stripped = value.slice('devin/'.length)
  return stripped || null
}

let cache: { models: Devin2ApiModel[]; expiresAt: number; baseUrl: string } | undefined
let pending: Promise<Devin2ApiModel[]> | undefined

export function resetDevin2ApiCatalog() { cache = undefined; pending = undefined }

export async function listDevin2ApiModels(options: { client?: Devin2ApiClient; fresh?: boolean } = {}): Promise<Devin2ApiModel[]> {
  const client = options.client || createDevin2ApiClient()
  const now = Date.now()
  if (!options.fresh && cache && cache.expiresAt > now && cache.baseUrl === client.baseUrl) return cache.models.map(model => ({ ...model }))
  if (!options.fresh && pending) return pending.then(models => models.map(model => ({ ...model })))
  const load = (async () => {
    const response = await client.listModels()
    if (!response.ok) throw Object.assign(new Error(`Devin sidecar model catalog returned HTTP ${response.status}`), { statusCode: 502 })
    let payload: unknown
    try { payload = await response.json() } catch { throw Object.assign(new Error('Devin sidecar model catalog is not valid JSON'), { statusCode: 502 }) }
    const models = parseDevin2ApiModels(payload)
    cache = { models, expiresAt: Date.now() + 15_000, baseUrl: client.baseUrl }
    return models
  })()
  if (!options.fresh) pending = load
  try { return (await load).map(model => ({ ...model })) } finally { if (pending === load) pending = undefined }
}

export async function listNamespacedDevin2ApiModels(options: { client?: Devin2ApiClient; fresh?: boolean } = {}) {
  return namespaceDevin2ApiModels(await listDevin2ApiModels(options))
}

export async function hasDevin2ApiModel(model: string, options: { client?: Devin2ApiClient; fresh?: boolean } = {}) {
  const id = stripDevin2ApiModel(model)
  if (!id) return false
  return (await listDevin2ApiModels(options)).some(item => item.id === id)
}
