import { randomBytes } from 'node:crypto'
import { getDb } from '../db'
import { getConfig } from '../config'
import { encryptSecret, decryptSecret, hashGatewayKey } from '../crypto'
import { platformError } from '../platform-error'
import { createCpaClient } from './client'
import { withKernelConfigLock } from './config-lock'
import { BRIDGE_KEY_PREFIX } from '../auth'
import { POOL_MODULE_ALIASES, type PoolModuleId } from '../../../shared/modules'

/**
 * Module bridge channels in the CPA kernel.
 *
 * Only this file, inside the kernel layer, writes CPA configuration. An
 * account-pool module declares what it offers (a route path and its model
 * IDs); the kernel registers an `openai-compatibility` channel pointing back
 * at that path, authenticated by a bridge key that only the kernel mints. The
 * kernel only ever touches channels it owns (names starting with `nexus-`);
 * every other channel in the user's CPA config is left untouched. Modules
 * never hold a CPA management key or call CPA's config API.
 */
type JsonObject = Record<string, unknown>
const CHANNEL_PREFIX = 'nexus-'
export function bridgeChannelName(moduleId: PoolModuleId) { return CHANNEL_PREFIX + moduleId }
export function bridgeAlias(moduleId: PoolModuleId) { return POOL_MODULE_ALIASES[moduleId] }
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)

export interface BridgeDeclaration {
  moduleId: PoolModuleId
  /** Path on this app the kernel calls, e.g. `/api/modules/logicc/bridge/v1`. */
  routePath: string
  /** Native model IDs the module currently serves. */
  models: string[]
}
export interface BridgeState { connected: boolean; channel: string; modelCount: number; updatedAt: string | null; error: string | null }

/** The bridge secret for a module, minting one on first use. Stored hashed + encrypted. */
export async function ensureBridgeSecret(moduleId: PoolModuleId): Promise<string> {
  return getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bridge:' + moduleId}, 0))`
    const rows = await tx`SELECT secret_ciphertext FROM nexus_module_bridges WHERE module_id=${moduleId} FOR UPDATE`
    if (rows[0]?.secret_ciphertext) { try { return decryptSecret(rows[0].secret_ciphertext) } catch { /* Re-mint below. */ } }
    const secret = BRIDGE_KEY_PREFIX + moduleId.replace(/[^a-z0-9]/g, '') + '_' + randomBytes(32).toString('base64url')
    await tx`INSERT INTO nexus_module_bridges(module_id,secret_hash,secret_ciphertext) VALUES(${moduleId},${hashGatewayKey(secret)},${encryptSecret(secret)})
      ON CONFLICT(module_id) DO UPDATE SET secret_hash=EXCLUDED.secret_hash,secret_ciphertext=EXCLUDED.secret_ciphertext,updated_at=now()`
    return secret
  })
}

/** Verify a bridge secret presented on a module's internal route; returns the module it belongs to. */
export async function verifyBridgeSecret(moduleId: string, secret: string): Promise<boolean> {
  if (!secret.startsWith(BRIDGE_KEY_PREFIX)) return false
  const rows = await getDb()`SELECT 1 FROM nexus_module_bridges WHERE module_id=${moduleId} AND secret_hash=${hashGatewayKey(secret)}`
  return rows.length > 0
}

function bridgeBaseUrl(): string {
  return getConfig().bridgeBaseUrl
}
function buildChannel(declaration: BridgeDeclaration, secret: string): JsonObject {
  const base = new URL(declaration.routePath, bridgeBaseUrl()).toString().replace(/\/+$/, '')
  const alias = bridgeAlias(declaration.moduleId)
  return {
    name: bridgeChannelName(declaration.moduleId),
    'base-url': base,
    'request-retry': 0,
    // The module runs its own account selection, cooldowns and retries; CPA must
    // not treat one module pool as a single account and apply a second policy.
    'disable-cooling': true,
    headers: Object.fromEntries(['X-Nexus-Original-Key-ID', 'X-Nexus-Route-Group', 'X-Nexus-Request-ID', 'X-Nexus-Route-Expires', 'X-Nexus-Route-Signature'].map(name => [name, '$' + name])),
    keys: [{ 'api-key': secret }],
    models: [...new Set(declaration.models)].sort().map(id => ({ name: id, alias: `${alias}/${id}` })),
  }
}
const isManaged = (group: unknown): group is JsonObject => isObject(group) && typeof group.name === 'string' && group.name.startsWith(CHANNEL_PREFIX)

async function readChannels(client = createCpaClient()): Promise<JsonObject[]> {
  const response = await client.request({ path: 'config/api-keys/openai-compatibility' })
  if (response.status === 404) return []
  if (response.status < 200 || response.status >= 300) throw platformError({ statusCode: 502, message: '读取 CPA 渠道失败，请检查核心连接' })
  try {
    const value = JSON.parse(new TextDecoder().decode(response.body))
    if (!Array.isArray(value) || value.some(group => !isObject(group))) throw new Error('invalid')
    return value as JsonObject[]
  } catch { throw platformError({ statusCode: 502, message: 'CPA 渠道配置格式不正确，未修改配置' }) }
}

/**
 * Make the module's bridge channel match its declaration, touching only that
 * one channel. With no models the channel is removed, so a module with no
 * serving accounts advertises nothing.
 */
export async function reconcileBridge(declaration: BridgeDeclaration): Promise<BridgeState> {
  const channelName = bridgeChannelName(declaration.moduleId)
  return withKernelConfigLock(async tx => {
    const client = createCpaClient()
    const secret = await ensureBridgeSecret(declaration.moduleId)
    const existing = await readChannels(client)
    const others = existing.filter(group => group.name !== channelName)
    const next = declaration.models.length ? [...others, buildChannel(declaration, secret)] : others
    // Only write when this module's channel actually changes.
    const current = existing.find(group => group.name === channelName)
    const desired = declaration.models.length ? buildChannel(declaration, secret) : undefined
    if (JSON.stringify(current ?? null) !== JSON.stringify(desired ?? null)) {
      const response = await client.request({ path: 'config/api-keys', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'openai-compatibility': next }) })
      if (response.status < 200 || response.status >= 300) {
        await tx`UPDATE nexus_module_bridges SET last_error='CPA 拒绝渠道配置，原渠道未替换',updated_at=now() WHERE module_id=${declaration.moduleId}`
        throw platformError({ statusCode: 502, message: 'CPA 拒绝渠道配置，请检查核心连接' })
      }
    }
    await tx`UPDATE nexus_module_bridges SET model_count=${declaration.models.length},connected_at=now(),last_error=NULL,updated_at=now() WHERE module_id=${declaration.moduleId}`
    return { connected: declaration.models.length > 0, channel: channelName, modelCount: declaration.models.length, updatedAt: new Date().toISOString(), error: null }
  })
}

export async function bridgeState(moduleId: PoolModuleId): Promise<BridgeState> {
  const channelName = bridgeChannelName(moduleId)
  const rows = await getDb()`SELECT model_count,connected_at,last_error FROM nexus_module_bridges WHERE module_id=${moduleId}`
  const row = rows[0]
  const base: BridgeState = { connected: false, channel: channelName, modelCount: row?.model_count || 0, updatedAt: row?.connected_at ? new Date(row.connected_at).toISOString() : null, error: row?.last_error || null }
  if (!row?.connected_at) return base
  try {
    const present = (await readChannels()).find(group => group.name === channelName)
    const models = Array.isArray(present?.models) ? present!.models.length : 0
    return { ...base, connected: !!present && models > 0, modelCount: models, error: present ? null : 'CPA 中尚未注册该模块渠道，请重新接入' }
  } catch { return { ...base, error: 'CPA 渠道状态暂时无法读取' } }
}

/** Remove a module's bridge channel entirely (module disabled or uninstalled). */
export async function removeBridge(moduleId: PoolModuleId): Promise<void> {
  const channelName = bridgeChannelName(moduleId)
  await withKernelConfigLock(async tx => {
    const client = createCpaClient()
    const existing = await readChannels(client).catch(() => null)
    if (!existing || !existing.some(group => group.name === channelName)) return
    const response = await client.request({ path: 'config/api-keys', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'openai-compatibility': existing.filter(group => group.name !== channelName) }) })
    if (response.status < 200 || response.status >= 300) throw platformError({ statusCode: 502, message: 'CPA 拒绝渠道配置，请检查核心连接' })
    await tx`UPDATE nexus_module_bridges SET model_count=0,connected_at=NULL,updated_at=now() WHERE module_id=${moduleId}`
  })
}

/** Identify the pool module that owns one of CPA's internal bridge model aliases. */
export function moduleForAlias(model: string): { moduleId: PoolModuleId; nativeModel: string } | null {
  const slash = model.indexOf('/')
  if (slash <= 0) return null
  const alias = model.slice(0, slash)
  const moduleId = (Object.keys(POOL_MODULE_ALIASES) as PoolModuleId[]).find(id => POOL_MODULE_ALIASES[id] === alias)
  return moduleId ? { moduleId, nativeModel: model.slice(slash + 1) } : null
}
export { isManaged }

/**
 * Remove kernel-owned bridge channels (`nexus-*`) that no current pool module
 * declares, e.g. the channels of the removed CommandCode module in the
 * `openai-compatibility` and `claude` families. User channels are untouched.
 */
export async function pruneStaleBridges(): Promise<string[]> {
  const current = new Set((Object.keys(POOL_MODULE_ALIASES) as PoolModuleId[]).map(bridgeChannelName))
  return withKernelConfigLock(async () => {
    const client = createCpaClient()
    const response = await client.request({ path: 'config/api-keys' })
    if (response.status < 200 || response.status >= 300) return []
    let config: JsonObject
    try { config = JSON.parse(new TextDecoder().decode(response.body)) } catch { return [] }
    if (!isObject(config)) return []
    const patch: JsonObject = {}
    const removed: string[] = []
    for (const family of ['openai-compatibility', 'claude']) {
      const groups = config[family]
      if (!Array.isArray(groups)) continue
      const stale = groups.filter(group => isManaged(group) && !current.has(String(group.name)))
      if (!stale.length) continue
      removed.push(...stale.map(group => String((group as JsonObject).name)))
      patch[family] = groups.filter(group => !stale.includes(group))
    }
    if (!removed.length) return []
    const write = await client.request({ path: 'config/api-keys', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    if (write.status < 200 || write.status >= 300) throw platformError({ statusCode: 502, message: 'CPA 拒绝渠道配置，旧桥接渠道未清理' })
    return removed
  })
}
