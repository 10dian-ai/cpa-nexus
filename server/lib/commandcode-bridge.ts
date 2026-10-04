import { randomBytes, randomUUID } from 'node:crypto'
import { platformError as createError } from './platform-error'
import { getDb } from './db'
import { encryptSecret, decryptSecret, hashGatewayKey } from './crypto'
import { listGatewayModels } from './gateway/accounts'
import { isModuleEnabled, requireModule } from './modules'
import { createCpaClient } from './cpa/client'
import { normalizeSupportedEndpoints } from './commandcode-provider'

export const COMMANDCODE_CHANNEL = 'nexus-commandcode'
export const COMMANDCODE_MESSAGES_CHANNEL = 'nexus-commandcode-messages'
export const BRIDGE_KEY_PREFIX = 'ccm_nexus_'
export interface BridgeView {
  configured: boolean; connected: boolean; modelCount: number
  updatedAt: string | null; error: string | null
}
export function commandcodeBaseURL(): string {
  const value = process.env.CPA_COMMANDCODE_BASE_URL || 'http://app:3000/v1'
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw createError({ statusCode: 500, message: 'CommandCode 内部上游地址配置无效' })
  return value.replace(/\/$/, '')
}
export function buildCommandcodeChannel(secret: string, models: { id: string }[], baseURL: string) {
  const ids = [...new Set(models.map(model => model.id))].sort()
  return {
    name: COMMANDCODE_CHANNEL,
    'base-url': baseURL,
    'request-retry': 0,
    'disable-cooling': true,
    headers: {
      'X-Session-ID': '$X-Session-ID',
      'X-Claude-Code-Session-ID': '$X-Claude-Code-Session-ID',
      'X-Codex-Session-ID': '$X-Codex-Session-ID',
      'X-Agent-ID': '$X-Agent-ID',
      'X-Subagent-ID': '$X-Subagent-ID',
      'X-Nexus-Client-Authorization': '$Authorization',
      'X-Nexus-Client-Api-Key': '$X-API-Key',
      'X-Cmd-Zdr': '$X-Cmd-Zdr',
      'Anthropic-Beta': '$Anthropic-Beta',
      'X-Nexus-Original-Key-ID': '$X-Nexus-Original-Key-ID',
      'X-Nexus-Original-Key-Signature': '$X-Nexus-Original-Key-Signature',
    },
    keys: [{ 'api-key': secret }],
    models: ids.map(id => ({ name: id, alias: `commandcode/${id}` })),
  }
}
export function buildCommandcodeMessagesChannel(secret: string, models: { id: string }[], baseURL: string) {
  return {
    ...buildCommandcodeChannel(secret, models, baseURL.replace(/\/v1$/, '')),
    name: COMMANDCODE_MESSAGES_CHANNEL,
    keys: [{ 'api-key': secret, cloak: { mode: 'never' } }],
  }
}
export function splitCommandcodeModels(models: { id: string; supported_endpoints?: string[] }[]) {
  return {
    chat: models.filter(model => {const endpoints=normalizeSupportedEndpoints(model.supported_endpoints);return endpoints.includes('chat/completions')&&!endpoints.includes('messages')}),
    messages: models.filter(model => normalizeSupportedEndpoints(model.supported_endpoints).includes('messages')),
  }
}
export function mergeCommandcodeChannel(groups: unknown, channel: ReturnType<typeof buildCommandcodeChannel>) {
  if (!Array.isArray(groups)) throw createError({ statusCode: 502, message: 'CPA 返回了无效的渠道配置，未执行覆盖' })
  if (groups.some(group => !group || typeof group !== 'object' || Array.isArray(group)))
    throw createError({ statusCode: 502, message: 'CPA 渠道配置格式不正确，未执行覆盖' })
  return [...groups.filter(group => group.name !== COMMANDCODE_CHANNEL), channel]
}
async function readGroups(client = createCpaClient(), path = 'config/api-keys/openai-compatibility'): Promise<unknown[]> {
  const result = await client.request({ path })
  if (result.status === 404) return []
  if (result.status < 200 || result.status >= 300) throw createError({ statusCode: 502, message: '读取 CPA 渠道失败，请检查核心连接' })
  try {
    const groups = JSON.parse(new TextDecoder().decode(result.body))
    if (!Array.isArray(groups)) throw new Error('Invalid list')
    return groups
  } catch { throw createError({ statusCode: 502, message: 'CPA 渠道配置无法读取，未执行覆盖' }) }
}
const channelMatches = (channel: unknown, name: string) => !!channel && typeof channel==='object' && (channel as {name?:string}).name===name
const managedPresent = (groups: unknown[]) => groups.some(group=>channelMatches(group,COMMANDCODE_CHANNEL)||channelMatches(group,COMMANDCODE_MESSAGES_CHANNEL))
async function ensureBridgeCredential(): Promise<string> {
  return getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(71645202)`
    const states = await tx`SELECT * FROM module_integrations WHERE module_id='commandcode' FOR UPDATE`
    const previous = states[0]
    if (previous?.key_id) {
      const secret = decryptSecret(previous.credential_ciphertext)
      const keys = await tx`SELECT id FROM gateway_keys WHERE id=${previous.key_id} AND secret_hash=${hashGatewayKey(secret)}`
      if (keys.length) {
        await tx`UPDATE gateway_keys SET enabled=true WHERE id=${previous.key_id}`
        return secret
      }
    }
    const secret = BRIDGE_KEY_PREFIX + randomBytes(32).toString('base64url')
    const id = randomUUID()
    await tx`INSERT INTO gateway_keys(id,name,prefix,secret_hash,enabled,module_id)
      VALUES(${id},'CPA Nexus · CommandCode 内部桥接',${secret.slice(0, 12)},${hashGatewayKey(secret)},true,'commandcode')`
    await tx`INSERT INTO module_integrations(module_id,key_id,credential_ciphertext)
      VALUES('commandcode',${id},${encryptSecret(secret)}) ON CONFLICT(module_id)
      DO UPDATE SET key_id=EXCLUDED.key_id,credential_ciphertext=EXCLUDED.credential_ciphertext,updated_at=now()`
    return secret
  })
}
export async function getCommandcodeBridge(): Promise<BridgeView> {
  const rows = await getDb()`SELECT model_count,connected_at,last_error,credential_ciphertext,key_id FROM module_integrations WHERE module_id='commandcode'`
  const row = rows[0]
  const view: BridgeView = {
    configured: !!row, connected: false, modelCount: row?.model_count || 0,
    updatedAt: row?.connected_at ? new Date(row.connected_at).toISOString() : null,
    error: row?.last_error || null,
  }
  if (!row) return view
  if (!await isModuleEnabled('commandcode')) return { ...view, error: 'CommandCode 模块已停用' }
  try {
    const client = createCpaClient()
    const groups = [...await readGroups(client),...await readGroups(client,'config/api-keys/claude')]
    const channels = groups.filter(group=>channelMatches(group,COMMANDCODE_CHANNEL)||channelMatches(group,COMMANDCODE_MESSAGES_CHANNEL)) as {name:string;models?:unknown[];'base-url'?:string;keys?:{'api-key'?:string}[]}[]
    const secret = decryptSecret(row.credential_ciphertext)
    const keys = await getDb()`SELECT enabled,secret_hash FROM gateway_keys WHERE id=${row.key_id}`
    const desired=splitCommandcodeModels((await listGatewayModels()).data)
    const required=[...(desired.chat.length?[COMMANDCODE_CHANNEL]:[]),...(desired.messages.length?[COMMANDCODE_MESSAGES_CHANNEL]:[])]
    view.connected = required.length>0 && required.every(name=>channels.some(channel=>channel.name===name)) && channels.every(channel=>channel['base-url']===(channel.name===COMMANDCODE_CHANNEL?commandcodeBaseURL():commandcodeBaseURL().replace(/\/v1$/,'')) && Array.isArray(channel.models) &&
      Array.isArray(channel.keys) && channel.keys.some(key=>key['api-key']===secret)) && keys[0]?.enabled===true && keys[0]?.secret_hash===hashGatewayKey(secret)
    if (view.connected) { view.modelCount = channels.reduce((count,channel)=>count+(channel.models?.length||0),0); view.error = null }
    else view.error = 'CPA 中尚未注册当前 CommandCode 渠道，请重新接入'
  } catch { view.error = 'CPA 渠道状态暂时无法读取' }
  return view
}
async function connectCommandcodeBridgeUnlocked(maintenance = false) {
  await requireModule('commandcode')
  const client = createCpaClient()
  const status = await client.status()
  if (!status.connected) throw createError({ statusCode: 503, message: status.error?.message || '请先连接 CPA 核心' })
  const initial = [...await readGroups(client),...await readGroups(client,'config/api-keys/claude')]
  if (maintenance && !managedPresent(initial))
    return { connected: false, name: COMMANDCODE_CHANNEL, models: 0 }
  const catalog = await listGatewayModels()
  const split=splitCommandcodeModels(catalog.data)
  if(!split.chat.length&&!split.messages.length)throw createError({statusCode:409,message:'账号池暂时没有可接入 CPA 的官方模型，请先导入 GOAT 账号并同步官方目录'})
  const secret = await ensureBridgeCredential()
  const channel=buildCommandcodeChannel(secret,split.chat,commandcodeBaseURL())
  const messagesChannel=buildCommandcodeMessagesChannel(secret,split.messages,commandcodeBaseURL())
  // Re-read just before replacing the provider list; keep other channels' latest values.
  const latest = await readGroups(client)
  const latestMessages=await readGroups(client,'config/api-keys/claude')
  if (maintenance && !managedPresent([...latest,...latestMessages]))
    return { connected: false, name: COMMANDCODE_CHANNEL, models: 0 }
  const next=maintenance&&!latest.some(group=>channelMatches(group,COMMANDCODE_CHANNEL))?latest:
    split.chat.length?mergeCommandcodeChannel(latest,channel):latest.filter(group=>!channelMatches(group,COMMANDCODE_CHANNEL))
  const nextMessages=latestMessages.filter(group=>!channelMatches(group,COMMANDCODE_MESSAGES_CHANNEL))
  if(split.messages.length&&(!maintenance||latestMessages.some(group=>channelMatches(group,COMMANDCODE_MESSAGES_CHANNEL))))nextMessages.push(messagesChannel)
  const result=await client.request({path:'config/api-keys',method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({'openai-compatibility':next,claude:nextMessages})})
  if (result.status < 200 || result.status >= 300) {
    await getDb()`UPDATE module_integrations SET last_error='CPA 拒绝渠道配置，原渠道未替换',updated_at=now() WHERE module_id='commandcode'`
    throw createError({ statusCode: 502, message: 'CPA 拒绝渠道配置，请检查核心连接与配置' })
  }
  const modelCount=next.filter(group=>channelMatches(group,COMMANDCODE_CHANNEL)).reduce<number>((count,group)=>count+((group as {models?:unknown[]}).models?.length||0),0)+
    nextMessages.filter(group=>channelMatches(group,COMMANDCODE_MESSAGES_CHANNEL)).reduce<number>((count,group)=>count+((group as {models?:unknown[]}).models?.length||0),0)
  await getDb()`UPDATE module_integrations SET model_count=${modelCount},connected_at=now(),last_error=NULL,updated_at=now()
    WHERE module_id='commandcode'`
  return { connected: true, name: COMMANDCODE_CHANNEL, models: modelCount }
}
async function updateCommandcodeBridge(maintenance = false) {
  return getDb().begin(async tx => {
    const lock = await tx`SELECT pg_try_advisory_xact_lock(71645203) AS acquired`
    if (lock[0]?.acquired !== true) throw createError({ statusCode: 409, message: '渠道接入正在执行，请稍后重试' })
    return connectCommandcodeBridgeUnlocked(maintenance)
  })
}
export async function connectCommandcodeBridge() { return updateCommandcodeBridge() }
export async function refreshCommandcodeBridge() {
  if (!await isModuleEnabled('commandcode')) return
  const states = await getDb()`SELECT connected_at FROM module_integrations WHERE module_id='commandcode'`
  // Registration remains an administrator action. Only maintain a channel already connected.
  if (!states[0]?.connected_at) return
  const client = createCpaClient()
  const groups=await readGroups(client)
  const messages=await readGroups(client,'config/api-keys/claude')
  // A channel explicitly removed in CPA is not silently recreated by the worker.
  if (!managedPresent([...groups,...messages])) return
  const catalog = await listGatewayModels()
  const split=splitCommandcodeModels(catalog.data)
  const expected=(models:{id:string}[])=>models.map(model=>model.id).sort().map(id=>({name:id,alias:`commandcode/${id}`}))
  const current=(collection:unknown[],name:string)=>((collection.find(group=>channelMatches(group,name)) as {models?:unknown})?.models)||[]
  if(JSON.stringify(current(groups,COMMANDCODE_CHANNEL))===JSON.stringify(expected(split.chat))&&JSON.stringify(current(messages,COMMANDCODE_MESSAGES_CHANNEL))===JSON.stringify(expected(split.messages)))return
  await updateCommandcodeBridge(true)
}
