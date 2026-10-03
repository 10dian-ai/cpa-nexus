import type { OfficialEndpoint } from '../../../shared/official-catalog'

type ObjectValue = Record<string, unknown>
export interface WebsiteModel { id: string; name: string; contextLength: number | null; minPlanName: string | null; vendor: string | null; category: string | null }
export interface ProviderModel { id: string; name: string; contextLength: number | null; supportedEndpoints: OfficialEndpoint[] }
export interface PricingPlan { id: string; name: string; price: string | null; credits: string | null; modelDescription: string | null }
export interface ParsedPage {
  models: WebsiteModel[]
  providerModels: ProviderModel[]
  documentedProviderModels: { id: string; supportedEndpoints: OfficialEndpoint[] }[]
  plans: PricingPlan[]
  scope: string[] | null
  allowances: Record<string, Record<string, number>>
  apiAccessExceptGo: boolean
  allModels: boolean
  paygAllModels: boolean
}
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
const optionalString = (value: unknown) => nonempty(value) ? value : null
const empty = (): ParsedPage => ({ models: [], providerModels: [], documentedProviderModels: [], plans: [], scope: null, allowances: {}, apiAccessExceptGo: false, allModels: false, paygAllModels: false })
const endpointSet = new Set<OfficialEndpoint>(['chat/completions', 'messages', 'responses', 'systemone'])

/** Decode the public React Router loader's reference table without evaluating page JavaScript. */
export function decodeRouterLoader(html: string): unknown {
  const match = html.match(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/)
  if (!match) throw new Error('Official model loader was not found')
  const table: unknown = JSON.parse(JSON.parse(match[1]!))
  if (!Array.isArray(table) || table.length > 50_000) throw new Error('Invalid official model loader')
  const resolved = new Map<number, unknown>()
  function resolve(reference: unknown, depth = 0): unknown {
    if (typeof reference !== 'number' || !Number.isInteger(reference) || depth > 80) throw new Error('Invalid loader reference')
    if (reference === -5) return undefined
    if (reference === -7) return null
    if (reference < 0 || reference >= (table as unknown[]).length) throw new Error('Unsupported loader reference')
    if (resolved.has(reference)) return resolved.get(reference)
    const value = (table as unknown[])[reference]
    if (Array.isArray(value)) { const output: unknown[] = []; resolved.set(reference, output); value.forEach(item => output.push(resolve(item, depth + 1))); return output }
    if (object(value)) {
      const output: ObjectValue = Object.create(null); resolved.set(reference, output)
      for (const [key, child] of Object.entries(value)) {
        if (!/^_\d+$/.test(key)) throw new Error('Unsupported loader object')
        const name = resolve(Number(key.slice(1)), depth + 1)
        if (typeof name !== 'string') throw new Error('Invalid loader key')
        output[name] = resolve(child, depth + 1)
      }
      return output
    }
    return value
  }
  return resolve(0)
}

/** Next.js splits JSON records across script chunks; concatenate strings before parsing. */
export function decodeDocumentRecords(html: string): unknown[] {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(match => JSON.parse(match[1]!))
  if (!chunks.length) throw new Error('Official document data was not found')
  const records: unknown[] = []; const bytes = Buffer.from(chunks.join(''), 'utf8')
  let cursor = 0
  while (cursor < bytes.length) {
    const colon = bytes.indexOf(58, cursor)
    const newline = bytes.indexOf(10, cursor)
    const end = newline < 0 ? bytes.length : newline
    if (colon < cursor || colon > end || colon - cursor > 12 || !/^[a-z0-9]+$/.test(bytes.subarray(cursor, colon).toString('ascii'))) { cursor = end + 1; continue }
    const start = colon + 1
    if (bytes[start] === 84) { // React's T records contain length-prefixed UTF-8 text, including newlines.
      const comma = bytes.indexOf(44, start)
      const length = bytes.subarray(start + 1, comma).toString('ascii')
      if (comma < start || !/^[0-9a-f]+$/.test(length)) throw new Error('Official document text frame is invalid')
      cursor = comma + 1 + Number.parseInt(length, 16)
      if (cursor > bytes.length) throw new Error('Official document text frame is incomplete')
      continue
    }
    const line = bytes.subarray(start, end).toString('utf8')
    if (line.startsWith('[') || line.startsWith('{')) {
      try { records.push(JSON.parse(line)) } catch { /* Other React record types are not catalog JSON. */ }
    }
    cursor = end + 1
  }
  if (!records.length) throw new Error('Official document data is incomplete')
  return records
}

function visit(value: unknown, callback: (value: ObjectValue | unknown[]) => void, seen = new Set<unknown>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value); callback(value as ObjectValue | unknown[])
  Object.values(value).forEach(child => visit(child, callback, seen))
}
function renderedText(value: unknown): string {
  if (typeof value === 'string') return value.startsWith('$$') ? value.slice(1) : value.startsWith('$') ? '' : value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value[0] === '$' ? renderedText(object(value[3]) ? value[3].children : null) : value.map(renderedText).join('')
  return object(value) ? renderedText(value.children) : ''
}
function websiteModels(value: unknown): WebsiteModel[] {
  if (!Array.isArray(value) || !value.length || value.length > 5000) throw new Error('Official model catalog is empty or invalid')
  const models = value.map(row => {
    if (!object(row) || !nonempty(row.id) || !nonempty(row.name)) throw new Error('Official model entry is invalid')
    return { id: row.id, name: row.name, contextLength: positive(row.contextWindow), minPlanName: optionalString(row.minPlanName), vendor: optionalString(row.vendor), category: optionalString(row.category) }
  })
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('Duplicate official model IDs')
  return models
}
export function parseProviderModels(json: string): ParsedPage {
  const body: unknown = JSON.parse(json)
  if (!object(body) || body.object !== 'list' || !Array.isArray(body.data) || !body.data.length || body.data.length > 5000) throw new Error('Provider model list is empty or invalid')
  const result = empty()
  result.providerModels = body.data.map(row => {
    if (!object(row) || !nonempty(row.id) || !nonempty(row.name) || !Array.isArray(row.supported_endpoints) || !row.supported_endpoints.length) throw new Error('Provider model endpoints are missing')
    const endpoints = row.supported_endpoints.map(value => {
      if (typeof value !== 'string') throw new Error('Invalid provider endpoint')
      const endpoint = value.replace(/^\//, '') as OfficialEndpoint
      if (!endpointSet.has(endpoint)) throw new Error('Unsupported provider endpoint: ' + endpoint)
      return endpoint
    })
    return { id: row.id, name: row.name, contextLength: positive(row.context_length), supportedEndpoints: [...new Set(endpoints)] }
  })
  if (new Set(result.providerModels.map(model => model.id)).size !== result.providerModels.length) throw new Error('Duplicate Provider model IDs')
  return result
}
export function parseWebsiteModels(html: string): ParsedPage {
  const decoded = decodeRouterLoader(html)
  if (!object(decoded) || !object(decoded.loaderData)) throw new Error('Official models route is missing')
  const route = decoded.loaderData['routes/models/index']
  if (!object(route)) throw new Error('Official models route changed')
  const result = empty(); result.models = websiteModels(route.models); return result
}

export function officialPlanId(name: string): string {
  const ids: Record<string, string> = { 'Go': 'go', 'GOAT': 'goat', 'Pro': 'pro', 'Provider': 'provider', 'Max 10×': 'max10', 'Max 20×': 'max20', 'Team Pro': 'team', 'Enterprise': 'enterprise' }
  return ids[name] || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function parsePlanTables(records: unknown[]): PricingPlan[] {
  const plans = new Map<string, PricingPlan>()
  for (const record of records) visit(record, value => {
    if (!Array.isArray(value) || value[0] !== '$' || value[1] !== 'table') return
    const rows: string[][] = []
    visit(value, node => {
      if (!Array.isArray(node) || node[1] !== 'tr' || !object(node[3])) return
      const cells: string[] = []
      visit(node[3].children, cell => { if (Array.isArray(cell) && ['td', 'th'].includes(String(cell[1]))) cells.push(renderedText(cell).replace(/\s+/g, ' ').trim()) })
      if (cells.length) rows.push(cells)
    })
    const headers = rows[0]
    if (!headers || headers[0] !== 'Plan' || !headers.includes('Price/mo') || !headers.includes('Models')) return
    for (const row of rows.slice(1)) {
      if (row.length !== headers.length || !row[0]) throw new Error('Official plan table is incomplete')
      const at = (key: string) => { const index = headers.indexOf(key); return index >= 0 ? row[index] || null : null }
      const id = officialPlanId(row[0]); plans.set(id, { id, name: row[0], price: at('Price/mo'), credits: at('Credits/mo'), modelDescription: at('Models') })
    }
  })
  return [...plans.values()]
}
export function parseOfficialDocument(html: string, kind: 'pricing' | 'go' | 'goat' | 'pro' | 'max' | 'provider'): ParsedPage {
  const records = decodeDocumentRecords(html); const result = empty(); const paragraphs: string[] = []
  for (const record of records) visit(record, value => {
    if (Array.isArray(value)) { if (value[1] === 'p' || value[1] === 'li') paragraphs.push(renderedText(value).replace(/\s+/g, ' ').trim()); return }
    if (object(value.planScope)) {
      const scope = value.planScope
      if (!nonempty(scope.label) || !Array.isArray(scope.modelIds) || !scope.modelIds.length || !scope.modelIds.every(nonempty)) throw new Error('Official plan model scope is incomplete')
      const expected = kind === 'goat' ? 'GOAT plan' : kind === 'pro' ? 'Pro plan' : kind === 'go' ? 'Go plan' : null
      if (expected && scope.label === expected) result.scope = [...new Set(scope.modelIds as string[])]
    }
    if (Array.isArray(value.models)) for (const model of value.models) {
      if (!object(model) || !nonempty(model.id) || !object(model.planAllowanceUsd)) continue
      const allowance: Record<string, number> = Object.create(null)
      for (const [plan, amount] of Object.entries(model.planAllowanceUsd)) if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) allowance[plan] = amount
      result.allowances[model.id] = allowance
    }
    // Special decision APIs can be documented before they appear in the public model list.
    // Bind endpoint and model only from the same official request example; never infer by name.
    if (kind === 'provider' && typeof value.code === 'string' && /\bcurl\s+https:\/\/api\.commandcode\.ai\/provider\/v1\/systemone(?:\s|$)/.test(value.code)) {
      const body = value.code.match(/(?:-d|--data(?:-raw)?)\s+'([\s\S]*?)'/)
      if (body) {
        try {
          const request: unknown = JSON.parse(body[1]!)
          if (object(request) && nonempty(request.model) && Object.hasOwn(request, 'state') && object(request.questions) && Object.keys(request.questions).length) {
            if (!result.documentedProviderModels.some(model => model.id === request.model)) result.documentedProviderModels.push({ id: request.model, supportedEndpoints: ['systemone'] })
          }
        } catch { /* Changed or incomplete examples cannot grant API support. */ }
      }
    }
  })
  const text = paragraphs.join('\n')
  // These are explicit official claims. Model membership always comes from IDs in planScope.
  result.apiAccessExceptGo = /Every plan except the Go plan has API access/i.test(text)
  result.allModels = kind === 'max' && /Both include every model\s*[-–—]/i.test(text)
  result.paygAllModels = /Provider for pay-as-you-go API access to all models/i.test(text) || /Extra pay-as-you-go credits[^.]*work on every model/i.test(text)
  if (kind === 'pricing') { result.plans = parsePlanTables(records); if (!result.plans.some(plan => plan.id === 'goat')) throw new Error('Official subscription table was not found') }
  if (['go', 'goat', 'pro'].includes(kind) && !result.scope) throw new Error('Official subscription model scope was not found')
  if (kind === 'max' && !result.allModels) throw new Error('Official Max model inclusion statement changed')
  if (kind === 'provider' && !result.apiAccessExceptGo) throw new Error('Official Provider API access statement changed')
  return result
}
