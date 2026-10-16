import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { IntakeHandler, IntakeItem, ParsedIntake } from '../intake/contract'
import { splitIntake } from '../intake/contract'
import type { IntakeRequest } from '../../../shared/intake'
import { platformError } from '../platform-error'
import { getDb } from '../db'
import { assertGroupIds, setAccountGroups } from '../groups'
import { createCpaClient } from './client'
import { withKernelConfigLock } from './config-lock'
import { configKeySourceId } from './preset-config-routing'
import { invalidateCpaGroupBindings, listCpaGroupSources, prepareCpaGroupSource, validateCpaSource } from './group-routing'

/**
 * Remote account adding for the CPA kernel. This lives in the kernel layer
 * because it writes CPA's credential store and provider configuration; no
 * module may do that. Accepted inputs, detected automatically:
 *
 *  1. Credential files (OAuth logins exported by CPA or its CLIs: Codex,
 *     Claude, Gemini, Qwen, iFlow, Antigravity …) → CPA credential store.
 *  2. Google service-account JSON → CPA's Vertex import.
 *  3. Provider API keys → appended to CPA's provider configuration:
 *       AIza…            gemini
 *       sk-ant-…         claude
 *       xai-…            xai          (https://api.x.ai/v1)
 *       sk-… / sk-proj-… codex        (https://api.openai.com/v1)
 *     A line may name the family and options explicitly:
 *       family|key[|base-url[|proxy-url]]   e.g. `claude|sk-ant-…|https://relay.example.com`
 *  4. Structured objects: `{ "provider": "claude", "apiKey": "…", "baseUrl": "…", "prefix": "…" }`
 *     and OpenAI-compatible channels `{ "provider": "openai-compatibility", "name": "relay", "baseUrl": "…", "apiKey": "…" }`.
 *
 * Existing keys and identical credential files are skipped, never duplicated.
 */
type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''

export const KEY_FAMILIES = ['gemini', 'claude', 'codex', 'xai', 'vertex', 'interactions', 'meta', 'openai-compatibility'] as const
type KeyFamily = typeof KEY_FAMILIES[number]
const FAMILY_ALIASES: Record<string, KeyFamily> = {
  gemini: 'gemini', google: 'gemini', 'gemini-api-key': 'gemini', 'ai-studio': 'gemini',
  claude: 'claude', anthropic: 'claude', 'claude-api-key': 'claude',
  codex: 'codex', openai: 'codex', 'codex-api-key': 'codex', gpt: 'codex',
  xai: 'xai', grok: 'xai',
  vertex: 'vertex', 'vertex-api-key': 'vertex',
  interactions: 'interactions', meta: 'meta',
  'openai-compatibility': 'openai-compatibility', 'openai-compatible': 'openai-compatibility', compatible: 'openai-compatibility', relay: 'openai-compatibility',
}
/** CPA ignores codex/xai entries without a base URL, so the official endpoints are filled in. */
const DEFAULT_BASE: Partial<Record<KeyFamily, string>> = { codex: 'https://api.openai.com/v1', xai: 'https://api.x.ai/v1' }
/** Group that remotely added keys join when no channel name is given. */
const INTAKE_GROUP_NAME = 'remote-intake'

interface KeyPayload { kind: 'key'; family: KeyFamily; apiKey: string; baseUrl: string; proxyUrl: string; prefix: string; name: string; models: unknown[] }
interface FilePayload { kind: 'file'; document: Json; name: string }
interface VertexPayload { kind: 'vertex'; document: Json; location: string }
type Payload = KeyPayload | FilePayload | VertexPayload

function detectFamily(key: string): KeyFamily | null {
  if (/^AIza[0-9A-Za-z_-]{30,}$/.test(key)) return 'gemini'
  if (/^sk-ant-[0-9A-Za-z_-]{20,}$/.test(key)) return 'claude'
  if (/^xai-[0-9A-Za-z_-]{20,}$/.test(key)) return 'xai'
  if (/^sk-(?:proj-|svcacct-|admin-)?[0-9A-Za-z_-]{20,}$/.test(key)) return 'codex'
  return null
}
function family(value: unknown): KeyFamily | null {
  return FAMILY_ALIASES[text(value).toLowerCase()] ?? null
}
function url(value: string, field: string): string {
  if (!value) return ''
  let parsed: URL
  try { parsed = new URL(value) } catch { throw platformError({ statusCode: 400, message: `${field} 不是有效地址` }) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw platformError({ statusCode: 400, message: `${field} 必须是 http(s) 地址且不含账号密码` })
  return value.replace(/\/+$/, '')
}
function proxy(value: string): string {
  if (!value) return ''
  if (!/^(?:https?|socks5h?):\/\/\S+$/i.test(value)) throw platformError({ statusCode: 400, message: '代理地址需为 http(s):// 或 socks5://' })
  return value
}
function keyPayload(input: { family: KeyFamily; apiKey: string; baseUrl?: string; proxyUrl?: string; prefix?: string; name?: string; models?: unknown }): KeyPayload {
  const apiKey = input.apiKey.trim()
  if (!apiKey || apiKey.length > 4000 || /\s/.test(apiKey)) throw platformError({ statusCode: 400, message: 'API Key 不能为空或包含空白' })
  const baseUrl = url(text(input.baseUrl), 'base-url') || DEFAULT_BASE[input.family] || ''
  if (input.family === 'openai-compatibility' && !baseUrl) throw platformError({ statusCode: 400, message: 'OpenAI 兼容渠道需要 base-url' })
  const prefix = text(input.prefix).replace(/^\/+|\/+$/g, '')
  if (prefix.includes('/') || prefix.length > 60) throw platformError({ statusCode: 400, message: 'prefix 不能包含斜杠且不超过 60 个字符' })
  const name = text(input.name).slice(0, 80)
  if (name.startsWith('nexus-')) throw platformError({ statusCode: 400, message: 'nexus- 开头的渠道名由内核保留' })
  if (input.family === 'openai-compatibility' && !name) throw platformError({ statusCode: 400, message: 'OpenAI 兼容渠道需要 name' })
  return { kind: 'key', family: input.family, apiKey, baseUrl, proxyUrl: proxy(text(input.proxyUrl)), prefix, name, models: Array.isArray(input.models) ? input.models.slice(0, 500) : [] }
}

function fromLine(line: string): Payload {
  const parts = line.split('|').map(part => part.trim())
  const named = family(parts[0])
  if (named && parts.length >= 2) {
    if (named === 'openai-compatibility') return keyPayload({ family: named, name: parts[1], apiKey: parts[2] || '', baseUrl: parts[3], proxyUrl: parts[4] })
    return keyPayload({ family: named, apiKey: parts[1]!, baseUrl: parts[2], proxyUrl: parts[3] })
  }
  const key = parts[0]!.replace(/^(['"])(.*)\1$/, '$2')
  const detected = detectFamily(key)
  if (!detected) throw platformError({ statusCode: 400, message: '无法识别的 Key：请使用 family|key 写法，例如 claude|sk-ant-…' })
  return keyPayload({ family: detected, apiKey: key, baseUrl: parts[1], proxyUrl: parts[2] })
}

function fromObject(value: Json): Payload {
  if (value.type === 'service_account' && text(value.private_key) && text(value.client_email))
    return { kind: 'vertex', document: value, location: text(value.location) || text(value.region) }
  const apiKey = text(value.apiKey) || text(value['api-key']) || text(value.api_key) || text(value.key)
  const named = family(value.provider) ?? family(value.family) ?? family(value.channel)
  // An object with a key and either a named family or a recognisable key is a provider key;
  // anything else is a credential file for CPA's store.
  if (apiKey && (named || detectFamily(apiKey))) {
    return keyPayload({ family: named ?? detectFamily(apiKey)!, apiKey,
      baseUrl: text(value.baseUrl) || text(value['base-url']) || text(value.base_url), proxyUrl: text(value.proxyUrl) || text(value['proxy-url']) || text(value.proxy_url),
      prefix: text(value.prefix), name: text(value.name), models: value.models })
  }
  if (!Object.keys(value).length) throw platformError({ statusCode: 400, message: '凭证内容为空' })
  if (!text(value.type) && !text(value.provider) && !Object.keys(value).some(key => /token|refresh|access|cookie|session|credential/i.test(key)))
    throw platformError({ statusCode: 400, message: '无法识别的 JSON：既不是 CPA 凭证文件，也没有 API Key 字段' })
  return { kind: 'file', document: value, name: credentialName(value) }
}

function credentialName(document: Json): string {
  const email = text(document.email)
  const type = text(document.type) || text(document.provider) || 'credential'
  const base = `${type}-${email || 'account'}`.toLowerCase().replace(/[^a-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'credential'
  // Stable for the same document, so re-submitting it is recognised as a duplicate.
  const digest = createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 8)
  return `${base}-${digest}.json`
}

function fingerprint(payload: Payload): string {
  const identity = payload.kind === 'key' ? [payload.family, payload.baseUrl, payload.apiKey].join('\0')
    : payload.kind === 'vertex' ? 'vertex\0' + text(payload.document.client_email) + '\0' + text(payload.document.private_key_id)
    : JSON.stringify(payload.document)
  return createHash('sha256').update('cpa:').update(identity).digest('hex')
}

async function readFamily(client: ReturnType<typeof createCpaClient>, name: KeyFamily): Promise<Json[]> {
  const response = await client.request({ path: `config/api-keys/${name}` })
  if (response.status === 404) return []
  if (response.status < 200 || response.status >= 300) throw platformError({ statusCode: 502, message: '读取 CPA 渠道配置失败，请检查内核连接' })
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(response.body)) } catch { throw platformError({ statusCode: 502, message: 'CPA 渠道配置格式不正确，未修改配置' }) }
  if (value === null) return []
  if (!Array.isArray(value) || value.some(group => !isObject(group))) throw platformError({ statusCode: 502, message: 'CPA 渠道配置格式不正确，未修改配置' })
  return value as Json[]
}

/** Append one provider key to CPA's configuration; returns false when the key already exists. */
async function addKey(payload: KeyPayload): Promise<boolean> {
  return withKernelConfigLock(async () => {
    const client = createCpaClient()
    const groups = await readFamily(client, payload.family)
    const exists = groups.some(group => text(group['base-url']).replace(/\/+$/, '') === payload.baseUrl &&
      Array.isArray(group.keys) && group.keys.some(key => isObject(key) && text(key['api-key']) === payload.apiKey))
    if (exists) return false
    const groupName = payload.name || INTAKE_GROUP_NAME
    const key: Json = { 'api-key': payload.apiKey, ...(payload.family === 'openai-compatibility' && payload.proxyUrl ? { 'proxy-url': payload.proxyUrl } : {}) }
    const index = groups.findIndex(group => text(group.name) === groupName && text(group['base-url']).replace(/\/+$/, '') === payload.baseUrl &&
      text(group.prefix) === payload.prefix && (payload.family === 'openai-compatibility' || text(group['proxy-url']) === payload.proxyUrl) && Array.isArray(group.keys))
    const next = groups.map(group => ({ ...group }))
    if (index >= 0) next[index] = { ...next[index], keys: [...(next[index]!.keys as Json[]), key] }
    else next.push({
      name: groupName,
      ...(payload.baseUrl ? { 'base-url': payload.baseUrl } : {}),
      ...(payload.prefix ? { prefix: payload.prefix } : {}),
      ...(payload.proxyUrl && payload.family !== 'openai-compatibility' ? { 'proxy-url': payload.proxyUrl } : {}),
      ...(payload.models.length ? { models: payload.models } : {}),
      keys: [key],
    })
    const response = await client.request({ path: 'config/api-keys', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [payload.family]: next }) })
    if (response.status < 200 || response.status >= 300) throw platformError({ statusCode: 502, message: 'CPA 拒绝了渠道配置，Key 未添加' })
    return true
  })
}

async function uploadFile(payload: FilePayload): Promise<boolean> {
  const client = createCpaClient()
  const existing = await client.request({ path: 'credentials/download', query: { name: payload.name } })
  if (existing.status === 200) return false
  const form = new FormData()
  form.set('file', new Blob([JSON.stringify(payload.document)], { type: 'application/json' }), payload.name)
  const response = await client.request({ path: 'credentials', method: 'POST', body: form })
  if (response.status === 409) return false
  if (response.status < 200 || response.status >= 300) throw platformError({ statusCode: 502, message: `CPA 拒绝了该凭证文件（HTTP ${response.status}）` })
  return true
}

async function importVertex(payload: VertexPayload): Promise<void> {
  const form = new FormData()
  form.set('file', new Blob([JSON.stringify(payload.document)], { type: 'application/json' }), 'service-account.json')
  if (payload.location) form.set('location', payload.location)
  const response = await createCpaClient().request({ path: 'oauth/import', method: 'POST', query: { provider: 'vertex' }, body: form })
  if (response.status < 200 || response.status >= 300) throw platformError({ statusCode: 502, message: `CPA 拒绝了该服务账号（HTTP ${response.status}）` })
}

/**
 * Bind a newly added source to the requested call groups. CPA may need a moment
 * to register it; a source that is still missing keeps the binding (stored
 * bindings survive until the source appears).
 */
async function bindGroups(sourceId: string, groupIds: string[]): Promise<string | undefined> {
  await assertGroupIds(groupIds)
  for (let attempt = 0; attempt < 4; attempt++) {
    const source = await validateCpaSource(sourceId).catch(() => null)
    if (source) {
      if (source.routingSupported === false) {
        await getDb().begin(tx => setAccountGroups(tx, 'cpa', sourceId, groupIds))
        invalidateCpaGroupBindings()
        return source.message || '已保存分组，但此来源暂不支持独立分组路由'
      }
      await prepareCpaGroupSource(sourceId)
      await getDb().begin(tx => setAccountGroups(tx, 'cpa', sourceId, groupIds))
      invalidateCpaGroupBindings()
      return undefined
    }
    await sleep(750 * (attempt + 1))
  }
  await getDb().begin(tx => setAccountGroups(tx, 'cpa', sourceId, groupIds))
  invalidateCpaGroupBindings()
  return '内核尚未注册该来源；分组已保存，来源出现后自动生效'
}

const FORMATS = [
  { id: 'credential-json', label: 'CPA 凭证文件', description: 'CPA 或各 CLI 登录导出的授权 JSON（Codex、Claude、Gemini、Qwen、iFlow、Antigravity 等），每个文件一个账号，也可放在数组里批量导入。', example: '{"type":"codex","email":"name@example.com","access_token":"…"}' },
  { id: 'vertex', label: 'Vertex 服务账号', description: 'Google Cloud 服务账号 JSON（type 为 service_account），可附 location 字段指定区域。', example: '{"type":"service_account","client_email":"…","private_key":"…"}' },
  { id: 'api-key', label: '提供商 API Key', description: '每行一个，自动识别：AIza… → Gemini，sk-ant-… → Claude，xai-… → xAI，sk-… → OpenAI/Codex。', example: 'sk-ant-api03-…' },
  { id: 'family-line', label: '指定渠道的 Key', description: '每行 渠道|Key|base-url|代理，渠道可写 gemini、claude、codex、xai、vertex 等；OpenAI 兼容写 openai-compatibility|名称|Key|base-url。', example: 'claude|sk-ant-…|https://relay.example.com' },
  { id: 'key-object', label: 'Key JSON', description: '对象或数组，字段 provider、apiKey、baseUrl、proxyUrl、prefix、name、models。', example: '[{"provider":"gemini","apiKey":"AIza…"}]' },
]

export const cpaIntake: IntakeHandler = {
  id: 'cpa',
  describe() {
    return {
      id: 'cpa', name: 'CPA 内核', icon: 'i-ph-cpu-bold',
      description: '给 CPA 内核加号：凭证文件、Vertex 服务账号和各提供商 API Key，自动识别格式，已存在的会跳过。',
      accept: '.json,.txt,.csv,.jsonl',
      formats: FORMATS,
    }
  },
  parse(request: IntakeRequest): ParsedIntake {
    const items: IntakeItem[] = []
    const errors: ParsedIntake['errors'] = []
    const seen = new Set<string>()
    for (const segment of splitIntake(request)) {
      try {
        const payload = typeof segment.value === 'string' ? fromLine(segment.value)
          : isObject(segment.value) ? fromObject(segment.value)
          : (() => { throw platformError({ statusCode: 400, message: '无法识别的条目' }) })()
        const id = fingerprint(payload)
        if (seen.has(id)) continue
        seen.add(id)
        items.push({ line: segment.line, fingerprint: id, payload: payload as unknown as Record<string, unknown> })
      } catch (error) {
        errors.push({ line: segment.line, message: error instanceof Error ? error.message : '条目格式不正确' })
      }
    }
    return { items, errors }
  },
  async process(raw, options) {
    const payload = raw as unknown as Payload
    if (payload.kind === 'key') {
      const added = await addKey(keyPayload(payload))
      if (!added) return { result: 'skipped', warning: '该 Key 已在 CPA 中' }
      const warning = options.groupIds?.length ? await bindGroups(configKeySourceId(payload.family, payload.baseUrl, payload.apiKey), options.groupIds) : undefined
      return { result: 'imported', ...(warning ? { warning } : {}) }
    }
    if (payload.kind === 'vertex') {
      if (!isObject(payload.document)) throw platformError({ statusCode: 400, message: '服务账号内容无效' })
      await importVertex(payload)
      return { result: 'imported', ...(options.groupIds?.length ? { warning: 'Vertex 服务账号由 CPA 命名，请在凭证分组页设置分组' } : {}) }
    }
    if (payload.kind === 'file' && isObject(payload.document)) {
      const uploaded = await uploadFile(payload)
      if (!uploaded) return { result: 'skipped', warning: '相同的凭证文件已存在' }
      const warning = options.groupIds?.length ? await bindGroups(payload.name, options.groupIds) : undefined
      return { result: 'imported', ...(warning ? { warning } : {}) }
    }
    throw platformError({ statusCode: 400, message: '凭证内容无效' })
  },
  async listAccounts(query) {
    const sources = await listCpaGroupSources()
    const needle = query.q?.toLowerCase()
    const matched = needle ? sources.filter(source => [source.name, source.provider, source.sourceId].some(value => value.toLowerCase().includes(needle))) : sources
    const start = (query.page - 1) * query.pageSize
    return {
      total: matched.length,
      items: matched.slice(start, start + query.pageSize).map(source => ({
        id: source.sourceId, name: source.name, provider: source.provider, enabled: source.enabled,
        groups: source.groupNames, routingSupported: source.routingSupported !== false,
      })),
    }
  },
  async pool() {
    const sources = await listCpaGroupSources().catch(() => [])
    const providers: Record<string, number> = {}
    for (const source of sources) providers[source.provider || 'other'] = (providers[source.provider || 'other'] ?? 0) + 1
    return { module: 'cpa', sources: sources.length, enabled: sources.filter(source => source.enabled).length, providers }
  },
}
