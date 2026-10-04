import { createHash } from 'node:crypto'
import type { GroupAccountView } from '../../../shared/groups'
import { createCpaClient, type CpaRequest } from './client'
import { ensureCpaConfigAccountRoute, readCpaConfigGroupSources, readCpaManagedBridgeSources } from './preset-config-routing'
import { resetCpaPresetAccountRoutes } from './preset-routing'
import { accountGroupBindings, ensureAccountGroups } from '../groups'
import { getDb } from '../db'
import { platformError } from '../platform-error'
import { ensureNativeCpaPrivacy } from './privacy'
import { getNexusCpaCapabilities, resetNexusCpaCapabilities } from './nexus-capabilities'

type JsonObject = Record<string, unknown>
type Client = ReturnType<typeof createCpaClient>
interface Source {
  id: string; name: string; provider: string; enabled: boolean; prefix: string
  authIds: string[]; fileName?: string; pluginId?: string; modelClientIDs?: string[]; supported: boolean; message?: string
}
export interface CpaGroupModel { id: string; object: 'model'; owned_by?: string; display_name?: string }
export interface CpaGroupSelection { accountId: string; model: string }
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const normalizePrefix = (value: unknown) => text(value).replace(/^\/+|\/+$/g, '')
const sourceFile = (credential: JsonObject) => text(credential.path).split(/[\\/]/).pop() || text(credential.name)
const fail = (statusCode: number, message: string) => platformError({ statusCode, message })
let inventory: { sources: Source[]; until: number } | undefined
let reading: Promise<Source[]> | undefined
const cursors = new Map<string, number>()
export function resetCpaGroupRouting() { inventory = undefined; reading = undefined; cursors.clear(); resetNexusCpaCapabilities() }

async function readJson(client: Client, input: CpaRequest): Promise<unknown> {
  const response = await client.request(input)
  if (response.status !== 200) throw fail(502, '无法读取 CPA 分组来源，请检查内核连接')
  try { return JSON.parse(new TextDecoder().decode(response.body)) } catch { throw fail(502, 'CPA 来源数据格式无效') }
}
async function readInventory(): Promise<Source[]> {
  const client = createCpaClient()
  const payload = await readJson(client, { path: 'credentials' })
  const credentials = object(payload) && (Array.isArray(payload.files) ? payload.files : payload.items)
  if (!Array.isArray(credentials) || credentials.some(item => !object(item))) throw fail(502, 'CPA 账号列表格式无效')
  const config = await readCpaConfigGroupSources(client)
  const capabilities = await getNexusCpaCapabilities()
  const managed = capabilities ? await readCpaManagedBridgeSources(client) : []
  const managedIndexes = new Set(managed.map(source => source.authIndex))
  const managedIDs = new Set(managed.flatMap(source => source.authIDs))
  const sources = new Map<string, Source>(config.map(source => [source.accountId, {
    id: source.accountId, name: source.name, provider: source.provider, enabled: source.enabled, prefix: source.prefix,
    authIds: capabilities?.groupPolicy.enabled ? [] : [...source.authIds], supported: capabilities?.groupPolicy.enabled ? true : source.supported,
    ...(!capabilities?.groupPolicy.enabled && source.reason ? { message: source.reason } : {}),
  }]))
  for (const credential of credentials as JsonObject[]) {
    if (managedIndexes.has(text(credential.auth_index)) || managedIDs.has(text(credential.id))) continue
    // Config entries and the private CommandCode bridges are inventoried from the native config tree.
    if (credential.source !== 'file' && !text(credential.path)) {
      if (sources.has('config:' + text(credential.auth_index)) || /^.*:apikey:|^openai-compatibility:/.test(text(credential.id))) continue
      const id = 'runtime:' + (text(credential.auth_index) || text(credential.id) || text(credential.name))
      if (id === 'runtime:') continue
      sources.set(id, { id, name: text(credential.label) || text(credential.name) || id, provider: text(credential.provider) || text(credential.type),
        enabled: credential.disabled !== true, prefix: '', authIds: [text(credential.id) || text(credential.name)], supported: !!capabilities?.groupPolicy.enabled,
        ...(!capabilities?.groupPolicy.enabled ? { message: '此运行时来源需要支持分组策略的 Nexus 内核，请更新内核后使用。' } : {}) })
      continue
    }
    const fileName = sourceFile(credential)
    if (!fileName) continue
    const authId = text(credential.id) || text(credential.name)
    const existing = sources.get(fileName)
    if (existing) { if (authId && !existing.authIds.includes(authId)) existing.authIds.push(authId); existing.enabled ||= credential.disabled !== true; continue }
    sources.set(fileName, { id: fileName, fileName, name: text(credential.email) || text(credential.label) || fileName,
      provider: text(credential.provider) || text(credential.type), enabled: credential.disabled !== true, prefix: '', authIds: authId ? [authId] : [], supported: true })
  }
  for (const account of capabilities?.runtimeAccounts || []) {
    if (managedIndexes.has(account.authIndex) || managedIDs.has(account.id)) continue
    const configSource = sources.get('config:' + account.authIndex)
    if (configSource) { if (!configSource.authIds.includes(account.id)) configSource.authIds.push(account.id); continue }
    // Runtime-only plugin children still share the physical source file's group, even when
    // the native source classifier correctly describes the child as memory at runtime.
    const id = account.sourcePath ? account.sourcePath.split(/[\\/]/).pop() || account.fileName
      : account.source === 'file' ? account.fileName
      : account.source === 'config' ? 'config:' + account.authIndex : 'runtime:' + (account.authIndex || account.id)
    if (!id) continue
    const existing = sources.get(id)
    if (existing) { if (!existing.authIds.includes(account.id)) existing.authIds.push(account.id); if (!existing.prefix && account.prefix) existing.prefix = account.prefix; continue }
    // Internal managed bridge credentials remain owned by CommandCode rather than another
    // CPA source. Their runtime ID starts with the native compatibility/config family.
    if (account.source === 'config') continue
    sources.set(id, { id, name: account.fileName || account.id, provider: account.provider, enabled: !account.disabled, prefix: account.prefix || '',
      authIds: [account.id], ...(account.source === 'file' ? { fileName: id } : {}), supported: capabilities!.groupPolicy.enabled })
  }
  for (const plugin of capabilities?.plugins || []) if (plugin.capabilities.executor) {
    const id = 'plugin:' + plugin.id
    sources.set(id, { id, pluginId: plugin.id, name: plugin.id, provider: plugin.provider || '插件执行器', enabled: true, prefix: '', authIds: [],
      modelClientIDs: plugin.modelClientIDs || [], supported: capabilities!.groupPolicy.enabled })
  }
  // File/config ownership wins over transient runtime labels. A disk cache miss can make
  // vanilla CPA report source=memory while retaining the physical path and the same auth ID.
  const ownedIds = new Set([...sources.values()].filter(source => source.fileName || source.id.startsWith('config:')).flatMap(source => source.authIds))
  for (const source of [...sources.values()]) if (source.id.startsWith('runtime:')) {
    source.authIds = source.authIds.filter(id => !ownedIds.has(id))
    if (!source.authIds.length) sources.delete(source.id)
  }
  // Disabled plugin children may disappear from the native runtime list. Consult the already
  // bound source files without changing any authorization or clearing missing-source bindings.
  const saved = await getDb()`SELECT DISTINCT account_id FROM nexus_account_groups WHERE module_id='cpa'`
  await each(saved, async binding => {
    const id = String(binding.account_id)
    if (sources.has(id) || id.startsWith('config:') || id.startsWith('runtime:') || id.startsWith('plugin:')) return
    const response = await client.request({ path: 'credentials/download', query: { name: id } })
    if (response.status === 404) return
    if (response.status !== 200) throw fail(502, '无法核验已绑定的 CPA 来源文件，原分组仍保留')
    let document: unknown
    try { document = JSON.parse(new TextDecoder().decode(response.body)) } catch { throw fail(502, '已绑定的 CPA 来源文件格式无效，原分组仍保留') }
    if (!object(document)) throw fail(502, '已绑定的 CPA 来源文件格式无效，原分组仍保留')
    sources.set(id, { id, fileName: id, name: text(document.email) || id, provider: text(document.type), enabled: document.disabled !== true,
      prefix: normalizePrefix(document.prefix), authIds: [], supported: true,
      message: document.disabled === true ? '来源已停用；分组绑定保留，重新启用后继续生效。' : '来源尚未注册可用的运行时模型，请检查提供器和账号状态。' })
  })
  const files = [...sources.values()].filter(source => source.fileName)
  if (!capabilities?.groupPolicy.enabled) await each(files, async source => {
    try {
      const document = await readJson(client, { path: 'credentials/download', query: { name: source.fileName! } })
      if (!object(document)) throw new Error('Invalid document')
      source.prefix = normalizePrefix(document.prefix)
      if (source.prefix.includes('/')) source.prefix = ''
    } catch { source.supported = false; source.message = '无法核验账号来源文件，请重新检查 CPA 连接。' }
  })
  return [...sources.values()]
}
async function each<T>(items: T[], callback: (item: T) => Promise<void>) {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) await callback(items[index++]!)
  }))
}
async function readSources(fresh = false): Promise<Source[]> {
  if (!fresh && inventory && inventory.until > Date.now()) return inventory.sources
  if (!fresh && reading) return reading
  const promise = readInventory().then(sources => { inventory = { sources, until: Date.now() + 5000 }; return sources })
  if (!fresh) reading = promise
  try { return await promise } finally { if (reading === promise) reading = undefined }
}

export async function listCpaGroupSources(options: { fresh?: boolean } = {}): Promise<GroupAccountView[]> {
  const sources = await readSources(options.fresh === true)
  let routingMessage = ''
  try { await assertCpaGroupRoutingSafe() } catch (error) { routingMessage = error instanceof Error ? error.message : '无法核验 CPA 插件分组路由' }
  const db = getDb()
  for (const source of sources) await ensureAccountGroups(db, 'cpa', source.id)
  const bindings = await accountGroupBindings('cpa', sources.map(source => source.id))
  return sources.map(source => ({ id: source.id, moduleId: 'cpa', sourceType: 'cpa', sourceId: source.id,
    name: source.name, provider: source.provider, enabled: source.enabled,
    ...(bindings.get(source.id) || { groupIds: [], groupNames: [] }),
    routingSupported: source.supported && !routingMessage, routingPrefix: source.prefix,
    ...(routingMessage || source.message ? { message: routingMessage || source.message } : {}),
  }))
}
export async function validateCpaSource(sourceId: string): Promise<GroupAccountView | null> {
  return (await listCpaGroupSources({ fresh: true })).find(source => source.sourceId === sourceId) || null
}

/** Preparing a source is the only operation here that changes native CPA routing configuration. */
export async function prepareCpaGroupSource(sourceId: string): Promise<void> {
  await getDb().begin(async transaction => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended('nexus:cpa:preset-prefix',0))`
    await transaction`SELECT pg_advisory_xact_lock(71645203)`
    const sources = await readSources(true), source = sources.find(item => item.id === sourceId)
    if (!source) throw fail(404, 'CPA 来源账号不存在')
    if (!source.supported) throw fail(409, source.message || '此 CPA 来源无法独立分组')
    const privacy = await ensureNativeCpaPrivacy({ locked: true, fileNames: source.fileName ? [source.fileName] : [] })
    if (privacy.changed) { inventory = undefined; resetCpaPresetAccountRoutes() }
    if ((await getNexusCpaCapabilities())?.groupPolicy.enabled) return
    if (source.prefix && !sources.some(other => other.id !== source.id && other.prefix === source.prefix)) return
    const prefix = 'nexus-' + createHash('sha256').update(sourceId).digest('hex').slice(0, 20)
    if (sources.some(other => other.id !== source.id && other.prefix === prefix)) throw fail(409, '生成的账号前缀已被其他来源使用，请先修改冲突前缀')
    const client = createCpaClient()
    if (source.fileName) {
      if (source.authIds.length === 1) {
        const response = await client.request({ path: 'credentials/fields', method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: source.fileName, prefix }) })
        if (response.status !== 200) throw fail(502, 'CPA 未保存分组账号前缀')
      } else {
        // Multi-project plugin children share one source and group. v8 forbids patching children;
        // source upload re-synthesizes every child, retaining all tokens and unknown JSON fields.
        const document = await readJson(client, { path: 'credentials/download', query: { name: source.fileName } })
        if (!object(document)) throw fail(502, 'CPA 来源文件格式无效')
        const response = await client.request({ path: 'credentials', method: 'POST', query: { name: source.fileName },
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...document, prefix }) })
        if (response.status !== 200) throw fail(502, 'CPA 未保存插件来源分组前缀')
      }
      const confirmed = await readJson(client, { path: 'credentials/download', query: { name: source.fileName } })
      if (!object(confirmed) || normalizePrefix(confirmed.prefix) !== prefix) throw fail(502, 'CPA 分组前缀未持久化')
    } else await ensureCpaConfigAccountRoute(client, { id: source.id }, prefix)
    inventory = undefined
    resetCpaPresetAccountRoutes()
  })
}

async function accountModels(source: Source, client: Client): Promise<CpaGroupModel[]> {
  const result = new Map<string, CpaGroupModel>()
  for (const authId of [...source.authIds, ...(source.modelClientIDs || [])]) {
    const payload = await readJson(client, { path: 'credentials/models', query: { name: authId } })
    if (!object(payload) || !Array.isArray(payload.models)) throw fail(502, 'CPA 来源模型目录格式无效')
    for (const model of payload.models) {
      if (!object(model) || !text(model.id)) continue
      result.set(text(model.id), { id: text(model.id), object: 'model', ...(text(model.owned_by) ? { owned_by: text(model.owned_by) } : {}),
        ...(text(model.display_name) ? { display_name: text(model.display_name) } : {}) })
    }
  }
  return [...result.values()]
}
async function allowedSources(groupIds: string[], fresh = false) {
  if (!groupIds.length) return []
  const sources = await readSources(fresh)
  for (const source of sources) await ensureAccountGroups(getDb(), 'cpa', source.id)
  const bindings = await accountGroupBindings('cpa', sources.map(source => source.id))
  const allowed = new Set(groupIds)
  return sources.filter(source => source.enabled && source.supported && bindings.get(source.id)?.groupIds.some(id => allowed.has(id)))
}
async function requireVerifiedPluginRouting(client: Client) {
  const capabilities = await getNexusCpaCapabilities()
  if (capabilities?.groupPolicy.enabled) return
  throw fail(503, capabilities ? '请配置 Nexus 内核分组策略密钥以使用模型 Key' : '请升级 Nexus 内核以使用模型 Key 分组；原生客户端功能继续保留')
}
/** Deprecated prefix helper verification retained only for migration/reference regression. */
async function requireLegacyPrefixRouting(client: Client) {
  const payload = await readJson(client, { path: 'plugins' })
  if (!object(payload) || !Array.isArray(payload.plugins)) throw fail(502, '无法核验 CPA 插件路由状态')
  // Original unpatched cores keep prefix routing for builtin sources. Full market support
  // requires the additive credential/plugin policy, never a plugin/version name whitelist.
  if (payload.plugins.some(plugin => object(plugin) && plugin.effective_enabled === true)) throw fail(503, '请更新 Nexus 内核以启用完整插件分组策略；原生客户端功能继续保留')
}
/** CommandCode aliases also execute through the stock core and must share this routing check. */
export async function assertCpaGroupRoutingSafe(): Promise<void> {
  await requireVerifiedPluginRouting(createCpaClient())
}
export interface CpaGroupPolicySelection { model: string; allowedAuthIDs: string[]; allowedPluginIDs: string[]; legacyPrefix?: boolean }
/** A router may rename an alias, but its complete execution chain inherits only this group union. */
export async function resolveCpaGroupPolicy(model: string, groupIds: string[], _keyId: string): Promise<CpaGroupPolicySelection | null> {
  if (model.startsWith('commandcode/') || !groupIds.length) return null
  const capabilities = await getNexusCpaCapabilities()
  if (!capabilities?.groupPolicy.enabled) throw fail(503, '请更新并配置 Nexus 内核以启用完整插件分组策略')
  const sources = await allowedSources(groupIds)
  if (!sources.length) return null
  return { model, allowedAuthIDs: [...new Set(sources.flatMap(source => source.authIds))],
    allowedPluginIDs: [...new Set(sources.flatMap(source => source.pluginId ? [source.pluginId] : []))] }
}
export async function resolveCommandcodeBridgePolicy(_keyId: string): Promise<{ allowedAuthIDs: string[]; allowedPluginIDs: string[]; legacyPrefix?: boolean }> {
  const capabilities = await getNexusCpaCapabilities()
  if (!capabilities?.groupPolicy.enabled) throw fail(503, '请更新并配置 Nexus 内核以启用 CommandCode 插件分组策略')
  const managed = await readCpaManagedBridgeSources(createCpaClient())
  const indexes = new Set(managed.map(source => source.authIndex))
  const expectedIDs = new Set(managed.flatMap(source => source.authIDs))
  const allowedAuthIDs = capabilities.runtimeAccounts.filter(account => !account.disabled && (indexes.has(account.authIndex) || expectedIDs.has(account.id))).map(account => account.id)
  if (!allowedAuthIDs.length) throw fail(503, 'CommandCode 托管渠道尚未注册到当前内核，请重新接入渠道')
  return { allowedAuthIDs: [...new Set(allowedAuthIDs)], allowedPluginIDs: [] }
}
function visibleModels(source: Source, models: CpaGroupModel[], preserveNativeIDs = false): CpaGroupModel[] {
  const visible = new Map<string, CpaGroupModel>()
  for (const model of models) {
    if (model.id.startsWith('commandcode/')) continue
    // Prefixes belong to real credentials. The public catalog exposes familiar bare model aliases,
    // while original source-prefixed aliases remain accepted by resolveCpaGroupModel.
    const id = !preserveNativeIDs && source.prefix && model.id.startsWith(source.prefix + '/') ? model.id.slice(source.prefix.length + 1) : model.id
    if (id && !id.startsWith('commandcode/')) visible.set(id, { ...model, id })
  }
  return [...visible.values()]
}
export async function listCpaGroupModels(groupIds: string[]): Promise<CpaGroupModel[]> {
  const sources = await allowedSources(groupIds), client = createCpaClient(), result = new Map<string, CpaGroupModel>()
  if (sources.length) await assertCpaGroupRoutingSafe()
  // Opaque policies retain the native model name. This also preserves force-model-prefix:
  // publishing a stripped alias would advertise a name the original core does not register.
  await each(sources, async source => { for (const model of visibleModels(source, await accountModels(source, client), true)) if (!result.has(model.id)) result.set(model.id, model) })
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function modelParts(model: string) {
  // The native thinking suffix remains byte-for-byte intact after source prefix selection.
  const match = /^(.*?)(\([^()]*\))$/.exec(model)
  return { base: match ? match[1]! : model, suffix: match ? match[2]! : '' }
}
export async function resolveCpaGroupModel(model: string, groupIds: string[], keyId: string): Promise<CpaGroupSelection | null> {
  if (model.startsWith('commandcode/')) return null
  const parts = modelParts(model), sources = await allowedSources(groupIds), client = createCpaClient()
  const candidates: Source[] = []
  await each(sources, async source => {
    const models = await accountModels(source, client)
    if (visibleModels(source, models).some(entry => entry.id === parts.base)
      || (source.prefix && parts.base.startsWith(source.prefix + '/') && models.some(entry => entry.id === parts.base))) candidates.push(source)
  })
  if (!candidates.length) return null
  await requireLegacyPrefixRouting(client)
  candidates.sort((a, b) => a.id.localeCompare(b.id))
  const cursorKey = keyId + '\0' + parts.base
  const cursor = cursors.get(cursorKey) || 0
  // Keep scheduling state bounded by active models without imposing request or upload size limits.
  if (cursors.size > 10_000) cursors.clear()
  cursors.set(cursorKey, cursor + 1)
  const source = candidates[cursor % candidates.length]!
  const originalBase = source.prefix && parts.base.startsWith(source.prefix + '/') ? parts.base.slice(source.prefix.length + 1) : parts.base
  await prepareCpaGroupSource(source.id)
  const deadline = Date.now() + 3000
  do {
    const all = await readSources(true), confirmed = all.find(item => item.id === source.id)
    if (!confirmed?.enabled || !confirmed.supported || !confirmed.prefix || all.some(other => other.id !== source.id && other.prefix === confirmed.prefix)) throw fail(409, 'CPA 来源账号路由已变化，请重新保存分组')
    const wanted = confirmed.prefix + '/' + originalBase
    const ownModels = await accountModels(confirmed, client)
    if (ownModels.some(entry => entry.id === wanted)) {
      // A custom model alias on another source must not impersonate this source's routing prefix.
      let collision = false
      await each(all.filter(other => other.id !== source.id && other.enabled), async other => {
        if ((await accountModels(other, client)).some(entry => entry.id === wanted)) collision = true
      })
      if (collision) throw fail(409, 'CPA 模型路由被其他来源共用，无法保证分组隔离，请修改冲突模型别名')
      const currentBinding = (await accountGroupBindings('cpa', [source.id])).get(source.id)
      if (!currentBinding?.groupIds.some(id => groupIds.includes(id))) throw fail(403, '此 CPA 来源已移出当前 Key 的分组')
      return { accountId: source.id, model: wanted + parts.suffix }
    }
    if (Date.now() >= deadline) break
    await new Promise<void>(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw fail(503, 'CPA 账号模型路由尚未就绪，请稍后重试')
}
