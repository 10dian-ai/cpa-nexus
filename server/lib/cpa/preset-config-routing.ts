import { createHash } from 'node:crypto'
import { CpaClientError, type CpaRequest, type CpaResponse } from './client'

type JsonObject = Record<string, unknown>
export interface CpaConfigCredential { id?: string; name?: string; auth_index?: string; runtime_only?: boolean; source?: string }
export interface CpaConfigAccountRoute { accountId: string; prefix: string; supported: boolean; reason?: string; name?: string; provider?: string }
export interface CpaConfigRoutingClient { request(input: CpaRequest): Promise<CpaResponse> }
interface Entry {
  family: string; groupIndex: number; keyIndex: number; id: string; authIndex: string; prefix: string; managed: boolean; name: string; enabled: boolean
}
const FAMILIES = ['gemini', 'interactions', 'claude', 'codex', 'xai', 'meta', 'openai-compatibility', 'vertex']
const MANAGED_CHANNELS = new Set(['nexus-commandcode', 'nexus-commandcode-messages'])
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const hash = (value: string, length: number) => createHash('sha256').update(value).digest('hex').slice(0, length)
const normalizedPrefix = (value: unknown) => {
  const result = string(value).replace(/^\/+|\/+$/g, '')
  return result.includes('/') ? '' : result
}
function bad(message: string, status = 409): never { throw new CpaClientError('cpa_account_route', message, status) }
function headersKey(value: unknown): string {
  if (!object(value)) return ''
  const headers: Record<string, string> = {}
  for (const [key, headerValue] of Object.entries(value)) if (key.trim() && string(headerValue)) headers[key.trim()] = string(headerValue)
  return Object.keys(headers).sort().map(key => key + '\0' + headers[key] + '\0').join('')
}

/** Matches v8.0.11 config synthesis and Auth.EnsureIndex. Secrets never leave this module.
 * https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.11/internal/watcher/synthesizer/config.go
 * https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.11/sdk/cliproxy/auth/types.go
 */
function entries(config: JsonObject): Entry[] {
  const result: Entry[] = []
  const counters = new Map<string, number>()
  const nextID = (kind: string, parts: string[]) => {
    const base = kind + ':' + hash([kind, ...parts.map(value => value.trim())].join('\0'), 12)
    const count = counters.get(base) || 0
    counters.set(base, count + 1)
    return base + (count ? '-' + count : '')
  }
  for (const family of FAMILIES) {
    const groups = config[family]
    if (groups === undefined || groups === null) continue
    if (!Array.isArray(groups) || groups.some(group => !object(group))) bad('CPA 上游分组配置格式无效，未修改配置', 502)
    groups.forEach((rawGroup, groupIndex) => {
      const group = rawGroup as JsonObject
      if (!Array.isArray(group.keys) || group.keys.some(key => !object(key))) bad('CPA 上游密钥配置格式无效，未修改配置', 502)
      // Disabled providers still need durable routes for when they are re-enabled.
      if (family === 'openai-compatibility' && !string(group['base-url'])) return
      const keys = group.keys as JsonObject[]
      const expanded = family === 'openai-compatibility' && keys.length === 0 ? [{}] : keys
      expanded.forEach((key, keyIndex) => {
        const effective = { ...group }
        if (family !== 'openai-compatibility') for (const [field, value] of Object.entries(key)) if (value !== null) effective[field] = value
        const apiKey = string(key['api-key'])
        let base = string(group['base-url'])
        if (family === 'meta' && !base) base = 'https://api.meta.ai/v1'
        if ((family === 'codex' || family === 'xai') && !base) return
        if (family === 'meta' && (!apiKey || apiKey.startsWith('dca:'))) return
        if (family !== 'openai-compatibility' && !apiKey && !base) return
        const prefix = normalizedPrefix(effective.prefix)
        const proxy = string(family === 'openai-compatibility' ? key['proxy-url'] : effective['proxy-url'])
        let kind = family === 'interactions' ? 'gemini-interactions:apikey' : family + ':apikey'
        let parts = [apiKey, base, proxy, prefix, headersKey(effective.headers)]
        if (family === 'openai-compatibility') {
          kind = 'openai-compatibility:' + (string(group.name).toLowerCase() || 'openai-compatibility')
          parts = keys.length ? [apiKey, base, proxy] : [base]
        } else if (family === 'vertex') parts = [apiKey, base, proxy]
        const id = nextID(kind, parts)
        const indexFamily = family === 'interactions' ? 'interactions' : family
        const seed = apiKey && family !== 'vertex'
          ? (family === 'openai-compatibility' ? family : indexFamily + '-api-key') + ':' + base + '+' + apiKey
          : 'id:' + id
        result.push({ family, groupIndex, keyIndex: keys.length ? keyIndex : -1, id, authIndex: hash(seed, 16), prefix,
          managed: MANAGED_CHANNELS.has(string(group.name)), name: (string(group.name) || family) + (expanded.length > 1 ? ' · Key ' + (keyIndex + 1) : ''),
          enabled: group.disabled !== true && key.disabled !== true && !(Array.isArray(effective['excluded-models']) && effective['excluded-models'].includes('*')) })
      })
    })
  }
  return result
}

export interface CpaConfigGroupSource {
  accountId: string; name: string; provider: string; prefix: string; authIds: string[]; enabled: boolean; supported: boolean; reason?: string
}

/** Safe source metadata for group routing; runtime IDs identify registry owners, never upstream secrets. */
export async function readCpaConfigGroupSources(client: CpaConfigRoutingClient): Promise<CpaConfigGroupSource[]> {
  const all = entries(await readConfig(client)).filter(entry => !entry.managed)
  const sources = new Map<string, CpaConfigGroupSource>()
  for (const entry of all) {
    const accountId = 'config:' + entry.authIndex
    const duplicate = all.filter(other => other.authIndex === entry.authIndex).length > 1
    const current = sources.get(accountId)
    if (current) { current.authIds.push(entry.id); current.enabled ||= entry.enabled; continue }
    sources.set(accountId, { accountId, name: entry.name, provider: entry.family, prefix: entry.prefix, authIds: [entry.id], enabled: entry.enabled,
      supported: !duplicate, ...(duplicate ? { reason: '重复的上游地址和密钥无法唯一分流，请先合并重复配置' } : {}) })
  }
  return [...sources.values()]
}
async function readConfig(client: CpaConfigRoutingClient): Promise<JsonObject> {
  const response = await client.request({ path: 'config/api-keys' })
  if (response.status < 200 || response.status >= 300) bad('读取 CPA 上游账号配置失败', 502)
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(response.body))
    if (object(value)) return value
  } catch { /* Do not expose configuration or provider secrets in errors. */ }
  bad('CPA 上游账号配置格式无效', 502)
}
function match(all: Entry[], credential: CpaConfigCredential): Entry | undefined {
  const identity = string(credential.id) || string(credential.name)
  const index = string(credential.auth_index) || (identity.startsWith('config:') ? identity.slice(7) : '')
  const matches = index ? all.filter(entry => entry.authIndex === index) : all.filter(entry => entry.id === identity || entry.id === string(credential.name))
  if (matches.length !== 1) return undefined
  // Stable account identities cannot distinguish repeated provider/base-url/key configurations.
  if (all.filter(entry => entry.authIndex === matches[0]!.authIndex).length !== 1) return undefined
  return matches[0]
}
function route(entry: Entry): CpaConfigAccountRoute {
  return { accountId: 'config:' + entry.authIndex, prefix: entry.prefix, supported: !entry.managed, name: entry.name, provider: entry.family,
    ...(entry.managed ? { reason: 'CommandCode 托管桥接渠道由模块管理，请在 CommandCode 账号页绑定预设' } : {}) }
}

export async function readCpaConfigAccountRoutes(client: CpaConfigRoutingClient, credentials: CpaConfigCredential[]): Promise<CpaConfigAccountRoute[]> {
  const all = entries(await readConfig(client))
  // Config API keys are normally omitted from CPA's auth-file list. Publish only safe, derived identities.
  const routes = all.map(entry => {
    const view = route(entry)
    if (all.filter(other => other.authIndex === entry.authIndex).length > 1) {
      view.supported = false
      view.prefix = ''
      view.reason = '重复的上游地址和密钥无法获得唯一稳定账号身份，请先合并重复配置'
    }
    return view
  })
  const seen = new Set(routes.map(route => route.accountId))
  const unknown = credentials.flatMap(credential => {
    const found = match(all, credential)
    if (found || seen.has('config:' + string(credential.auth_index))) return []
    if (credential.runtime_only === true || credential.source === 'memory' || string(credential.id).startsWith('config:')) {
      return [{ accountId: string(credential.auth_index) ? 'config:' + string(credential.auth_index) : string(credential.name) || string(credential.id),
        prefix: '', supported: false, reason: '无法唯一匹配 CPA 配置账号，重复凭据或插件账号暂不支持独立预设路由' }]
    }
    return []
  })
  return [...routes.filter((route, index) => routes.findIndex(other => other.accountId === route.accountId) === index), ...unknown]
}

/** The caller must hold the shared CPA configuration advisory lock around this read/modify/write. */
export async function ensureCpaConfigAccountRoute(client: CpaConfigRoutingClient, credential: CpaConfigCredential, prefix: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(prefix)) bad('账号路由前缀格式无效', 400)
  const config = await readConfig(client)
  const all = entries(config)
  const found = match(all, credential)
  if (!found) bad('无法唯一匹配 CPA 配置账号，未修改配置')
  if (found.managed) bad('CommandCode 托管桥接渠道不可作为 CPA 原生账号修改')
  if (all.some(entry => entry.authIndex !== found.authIndex && entry.prefix === prefix)) bad('该路由前缀已被其他 CPA 账号使用')
  if (found.prefix === prefix) return
  const groups = structuredClone(config[found.family]) as JsonObject[]
  const group = groups[found.groupIndex]!
  const keys = group.keys as JsonObject[]
  if (found.family !== 'openai-compatibility') {
    // v8 native families support per-key overrides; preserve shared group fields and sibling keys.
    keys[found.keyIndex] = { ...keys[found.keyIndex], prefix }
  } else if (keys.length <= 1) {
    group.prefix = prefix
  } else {
    // Compatibility prefix is provider-wide. Give the selected key its own uniquely named provider.
    const target = structuredClone(group)
    const usedNames = new Set(groups.map(group => string(group.name).toLowerCase()))
    const baseName = (string(group.name) || 'openai-compatibility') + '-nexus-' + found.authIndex
    let name = baseName
    let suffix = 1
    while (usedNames.has(name.toLowerCase())) name = baseName + '-' + suffix++
    target.name = name
    target.prefix = prefix
    target.keys = [keys[found.keyIndex]!]
    group.keys = keys.filter((_key, index) => index !== found.keyIndex)
    groups.splice(found.groupIndex + 1, 0, target)
  }
  const response = await client.request({ path: 'config/api-keys', method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [found.family]: groups }) })
  if (response.status < 200 || response.status >= 300) bad('CPA 拒绝账号路由配置，绑定未完成', 502)
  // Read persisted configuration after CPA reload. Native runtime IDs change with prefix; auth_index stays stable.
  const persisted = entries(await readConfig(client)).filter(entry => entry.authIndex === found.authIndex)
  if (persisted.length !== 1 || persisted[0]!.prefix !== prefix) bad('CPA 账号路由前缀保存后核对失败', 502)
}
