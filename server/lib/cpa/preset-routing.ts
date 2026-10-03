import { createHash } from 'node:crypto'
import { createCpaClient } from './client'
import { getDb } from '../db'
import { platformError } from '../platform-error'
import { readCpaConfigAccountRoutes, ensureCpaConfigAccountRoute } from './preset-config-routing'

export interface CpaPresetAccountRoute { accountId: string; credentialName: string; prefix: string; supported: boolean; message?: string }
type Credential = Record<string, unknown>
let cached: { accounts: CpaPresetAccountRoute[]; until: number } | undefined
let generation = 0
let pending: { generation: number; promise: Promise<CpaPresetAccountRoute[]> } | undefined
export function resetCpaPresetAccountRoutes() { cached = undefined; generation++ }
const fail = (statusCode: number, message: string) => platformError({ statusCode, message })
const isFile = (credential: Credential) => credential.runtime_only !== true && credential.source === 'file'
const credentialName = (credential: Credential) => String(credential.name || credential.id || '')
const accountName = (credential: Credential) => isFile(credential) ? credentialName(credential) : 'config:' + String(credential.auth_index || '')
async function readCredentials(client = createCpaClient()): Promise<Credential[]> {
  const response = await client.request({ path: 'credentials' })
  if (response.status !== 200) throw fail(502, '无法读取 CPA 账号，请检查核心连接')
  let data: any
  try { data = JSON.parse(new TextDecoder().decode(response.body)) } catch { throw fail(502, 'CPA 账号列表无效') }
  const files = Array.isArray(data.files) ? data.files : Array.isArray(data.items) ? data.items : undefined
  if (!files || files.some((file: unknown) => !file || typeof file !== 'object' || Array.isArray(file))) throw fail(502, 'CPA 账号列表无效')
  return files
}
async function filePrefix(client: ReturnType<typeof createCpaClient>, credential: Credential): Promise<string> {
  const response = await client.request({ path: 'credentials/download', query: { name: credentialName(credential) } })
  if (response.status !== 200) throw fail(502, '无法读取 CPA 账号路由配置')
  let data: unknown
  try { data = JSON.parse(new TextDecoder().decode(response.body)) } catch { throw fail(502, 'CPA 账号路由配置无效') }
  // Credential tokens and the rest of the account document stay on the server.
  const prefix = (data as Record<string, unknown>)?.prefix
  return typeof prefix === 'string' ? prefix.trim().replace(/^\/+|\/+$/g, '') : ''
}
async function readRoutes(): Promise<CpaPresetAccountRoute[]> {
  const client = createCpaClient(), credentials = await readCredentials(client)
  const fileNameCounts = new Map<string, number>()
  for (const credential of credentials.filter(isFile)) {
    const name = credentialName(credential)
    fileNameCounts.set(name, (fileNameCounts.get(name) || 0) + 1)
  }
  const config = new Map((await readCpaConfigAccountRoutes(client, credentials)).map(route => [route.accountId, route]))
  const accounts: CpaPresetAccountRoute[] = new Array(credentials.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, credentials.length) }, async () => {
    while (index < credentials.length) {
      const current = index++, credential = credentials[current]!, accountId = accountName(credential), name = credentialName(credential)
      if (!isFile(credential)) {
        const route = config.get(accountId)
        accounts[current] = route ? { accountId, credentialName: name, prefix: route.prefix, supported: route.supported, ...(route.reason ? { message: route.reason } : {}) }
          : { accountId, credentialName: name, prefix: '', supported: false, message: '此运行时凭据没有可持久化的账号路由，请选择模块默认预设。' }
        continue
      }
      if ((fileNameCounts.get(name) || 0) > 1) {
        accounts[current] = { accountId, credentialName: name, prefix: '', supported: false,
          message: '同一凭据文件提供多个运行时账号，CPA 不支持单独修改这些虚拟账号的路由；请在源文件或插件中管理。' }
        continue
      }
      try { accounts[current] = { accountId, credentialName: name, prefix: await filePrefix(client, credential), supported: true } }
      catch { accounts[current] = { accountId, credentialName: name, prefix: '', supported: false, message: '账号路由配置暂时无法读取，请重新检测。' } }
    }
  }))
  for (const route of accounts) if (route.prefix && accounts.filter(account => account.prefix === route.prefix).length > 1) {
    route.message = '多个账号共用模型前缀；保存账号路由时会分配独占前缀。'
  }
  for (const route of config.values()) if (!accounts.some(account => account.accountId === route.accountId)) accounts.push({
    accountId: route.accountId, credentialName: route.name || route.accountId, prefix: route.prefix, supported: route.supported,
    ...(route.reason ? { message: route.reason } : {}),
  })
  return accounts
}
export async function listCpaPresetAccountRoutes(options: { fresh?: boolean } = {}): Promise<CpaPresetAccountRoute[]> {
  if (!options.fresh && cached && cached.until > Date.now()) return cached.accounts
  if (pending?.generation === generation) return pending.promise
  const readingGeneration = generation
  const promise = readRoutes().then(accounts => {
    if (generation === readingGeneration) cached = { accounts, until: Date.now() + 5_000 }
    return accounts
  }).finally(() => { if (pending?.promise === promise) pending = undefined })
  pending = { generation: readingGeneration, promise }
  return promise
}

/** Account-specific processing uses a real CPA prefix; the core retains model execution and protocol conversion. */
export async function ensureCpaPresetAccountRoute(accountId: string): Promise<CpaPresetAccountRoute> {
  return getDb().begin(async transaction => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended('nexus:cpa:preset-prefix',0))`
    // Both features update provider config arrays. Share the existing bridge lock to prevent lost updates.
    await transaction`SELECT pg_advisory_xact_lock(71645203)`
    const client = createCpaClient(), credentials = await readCredentials(client)
    let credential = credentials.find(item => accountName(item) === accountId)
    if (!credential && /^config:[a-f0-9]{16}$/.test(accountId)) credential = { id: accountId, auth_index: accountId.slice(7), source: 'config' }
    if (!credential) throw fail(404, 'CPA 账号不存在')
    const routes = await listCpaPresetAccountRoutes({ fresh: true }), current = routes.find(route => route.accountId === accountId)
    if (!current?.supported) throw fail(409, current?.message || '此 CPA 账号不支持独立的预设路由')
    let prefix = current.prefix
    if (!prefix || routes.some(route => route.accountId !== accountId && route.prefix === prefix)) {
      prefix = 'nexus-' + createHash('sha256').update(accountId).digest('hex').slice(0, 20)
      if (routes.some(route => route.accountId !== accountId && route.prefix === prefix)) throw fail(409, '生成的账号前缀已被其他账号使用，请修改冲突前缀')
      if (isFile(credential)) {
        const response = await client.request({ path: 'credentials/fields', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: credentialName(credential), prefix }) })
        if (response.status !== 200) throw fail(502, 'CPA 未保存账号前缀，预设绑定未执行')
        // CPA's Update can report success even if persistence fails. Read the saved file before accepting it.
        if (await filePrefix(client, credential) !== prefix) throw fail(502, 'CPA 账号前缀未持久保存，预设绑定未执行')
      } else await ensureCpaConfigAccountRoute(client, credential, prefix)
      resetCpaPresetAccountRoutes()
      const confirmed = (await listCpaPresetAccountRoutes({ fresh: true })).find(route => route.accountId === accountId)
      if (!confirmed?.supported || confirmed.prefix !== prefix) throw fail(502, 'CPA 账号前缀核验失败，预设绑定未执行')
      if (isFile(credential)) {
        credential = (await readCredentials(client)).find(item => accountName(item) === accountId)
        if (!credential) throw fail(502, 'CPA 账号路由身份核验失败，预设绑定未执行')
      }
    }
    // CPA config writes are durable before model registration finishes. Wait for the real catalog,
    // but never infer a selected account's availability from another account's model count.
    const deadline = Date.now() + 3_000
    let models: unknown[] = []
    let registered = false
    do {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      let modelBytes: Uint8Array
      if (isFile(credential)) {
        const response = await client.request({ path: 'credentials/models', query: { name: credentialName(credential) }, signal })
        if (response.status !== 200) throw fail(502, '无法核验 CPA 账号模型路由，预设绑定未执行')
        modelBytes = response.body
      } else {
        const response = await fetch(new URL('/v1/models', process.env.CPA_URL || 'http://cpa:8317'), { headers: process.env.CPA_CLIENT_KEY ? { authorization: 'Bearer ' + process.env.CPA_CLIENT_KEY } : {}, signal, redirect: 'error' })
        if (response.status !== 200) throw fail(502, '无法核验 CPA 账号模型路由，预设绑定未执行')
        modelBytes = new Uint8Array(await response.arrayBuffer())
      }
      let payload: any
      try { payload = JSON.parse(new TextDecoder().decode(modelBytes)) } catch { throw fail(502, 'CPA 账号模型路由格式无效') }
      const catalog: unknown = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : undefined
      if (!Array.isArray(catalog)) throw fail(502, 'CPA 账号模型路由格式无效')
      models = catalog
      registered = models.some(model => !!model && typeof model === 'object' && typeof (model as Record<string, unknown>).id === 'string' && String((model as Record<string, unknown>).id).startsWith(prefix + '/'))
      if (registered || Date.now() >= deadline) break
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
    } while (Date.now() < deadline)
    if (isFile(credential) && models.length && !registered) throw fail(409, 'CPA 尚未注册该账号前缀的模型，请检查账号的模型权限和别名')
    return { accountId, credentialName: current.credentialName, prefix, supported: true,
      ...(!registered ? { message: isFile(credential) ? '该账号暂未提供可调用模型，模型就绪后可使用前缀路由。' : '前缀已保存，模型目录尚未就绪，等待模型同步后使用。' } : {}) }
  }) as Promise<CpaPresetAccountRoute>
}

export async function findCpaPresetAccountForModel(model: string): Promise<string | null> {
  const bindings = await getDb()`SELECT account_id FROM nexus_preset_bindings WHERE module_id='cpa' AND account_id<>''`
  if (!bindings.length) return null
  const wanted = new Set(bindings.map(binding => binding.account_id))
  const matches = (await listCpaPresetAccountRoutes()).filter(route => wanted.has(route.accountId) && route.supported && route.prefix && model.startsWith(route.prefix + '/'))
  if (matches.length !== 1) {
    if (matches.length) throw fail(409, 'CPA 账号路由前缀不再独占，请重新保存账号路由')
    return null
  }
  const chosen = matches[0]!
  if ((await listCpaPresetAccountRoutes()).filter(route => route.prefix === chosen.prefix).length !== 1) throw fail(409, 'CPA 账号路由前缀不再独占，请重新保存账号路由')
  return chosen.accountId
}
