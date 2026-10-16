import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError, deleteCookie, getCookie, getHeader, setCookie, type H3Event } from 'h3'
import { getConfig } from './config'
import { getDb } from './db'
import { getRedis } from './redis'
import { hashGatewayKey } from './crypto'
import { isModuleEnabled } from './modules'
import { isIntakeModuleId, type IntakeModuleId } from '../../shared/intake'
import type { AuthenticatedModelKey, ModelModuleId } from '../../shared/keys'
const COOKIE = 'ccm_session'
const SESSION_TTL = 7 * 24 * 3600
const digest = (value: string) => createHash('sha256').update(value).digest()
const sessionKey = (token: string) => 'ccm:admin:session:' + hashGatewayKey(token)
/** Internal bridge secrets are minted by the kernel layer and never authenticate clients. */
export const BRIDGE_KEY_PREFIX = 'ccm_nexus_'
export function validAdminCredentials(username: string, password: string) {
  const config = getConfig()
  return timingSafeEqual(digest(username), digest(config.adminUsername)) && timingSafeEqual(digest(password), digest(config.adminPassword))
}
export async function getAdminSession(event: H3Event): Promise<{ username: string } | null> {
  const token = getCookie(event, COOKIE)
  if (!token) return null
  const username = await getRedis().get(sessionKey(token))
  return username ? { username } : null
}
export async function requireAdmin(event: H3Event) {
  const session = await getAdminSession(event)
  if (!session) throw createError({ statusCode: 401, statusMessage: '请先登录管理后台' })
  return session
}
export async function startAdminSession(event: H3Event) {
  const config = getConfig(); const token = randomBytes(32).toString('base64url')
  await getRedis().set(sessionKey(token), config.adminUsername, 'EX', SESSION_TTL)
  setCookie(event, COOKIE, token, { httpOnly: true, secure: new URL(config.appUrl).protocol === 'https:', sameSite: 'strict', path: '/', maxAge: SESSION_TTL })
}
export async function endAdminSession(event: H3Event) {
  const token = getCookie(event, COOKIE)
  if (token) await getRedis().del(sessionKey(token))
  deleteCookie(event, COOKIE, { path: '/' })
}
const modelModule = (value: unknown): ModelModuleId => value === 'cpa' ? 'cpa' : 'auto'
export async function authenticateGatewayKey(secret: string): Promise<AuthenticatedModelKey | null> {
  if (!secret.startsWith('ccm_') || secret.startsWith('ccm_service_') || secret.startsWith(BRIDGE_KEY_PREFIX) || secret.length > 200) return null
  const db = getDb()
  const rows = await db<{ id: string; name: string; module_id: string }[]>`SELECT id,name,module_id FROM gateway_keys WHERE secret_hash=${hashGatewayKey(secret)} AND enabled=true LIMIT 1`
  const row = rows[0]
  if (!row) return null
  const key: AuthenticatedModelKey = { id: row.id, name: row.name, moduleId: modelModule(row.module_id) }
  await db`UPDATE gateway_keys SET last_used_at=now() WHERE id=${key.id} AND (last_used_at IS NULL OR last_used_at < now()-interval '1 minute')`
  return key
}
/** Signed kernel callbacks resolve the current enabled key and its binding again. */
export async function findEnabledModelKey(id: string): Promise<AuthenticatedModelKey | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
  const rows = await getDb()<{ id: string; name: string; module_id: string }[]>`SELECT id,name,module_id FROM gateway_keys
    WHERE id=${id} AND enabled=true AND left(prefix,10)<>'ccm_nexus_' LIMIT 1`
  const row = rows[0]
  return row ? { id: row.id, name: row.name, moduleId: modelModule(row.module_id) } : null
}

export interface ServiceKey { id: string; name: string; moduleIds: IntakeModuleId[] }
export async function authenticateServiceKey(secret: string): Promise<ServiceKey | null> {
  if (!/^ccm_service_[A-Za-z0-9_-]{43}$/.test(secret)) return null
  const db = getDb()
  const rows = await db<{ id: string; name: string; module_ids: string[] }[]>`SELECT id,name,module_ids FROM service_keys WHERE secret_hash=${hashGatewayKey(secret)} AND enabled=true LIMIT 1`
  const key = rows[0]
  if (!key) return null
  await db`UPDATE service_keys SET last_used_at=now() WHERE id=${key.id} AND (last_used_at IS NULL OR last_used_at < now()-interval '1 minute')`
  return { id: key.id, name: key.name, moduleIds: (key.module_ids || []).filter(isIntakeModuleId) }
}

/** Address of the caller as seen by the edge proxy or the intake page service. */
export function clientAddress(event: H3Event): string {
  const real = getHeader(event, 'x-real-ip')?.trim()
  if (real && real.length <= 64) return real
  return event.node.req.socket.remoteAddress || 'unknown'
}

/** Failed external authentications tolerated per address within ten minutes. */
export const EXTERNAL_AUTH_FAILURE_LIMIT = 30
/** External API requests allowed per service key per minute. */
export const EXTERNAL_REQUEST_LIMIT = 240

function tooMany(event: H3Event, seconds: number, message: string): never {
  event.node.res.setHeader('retry-after', String(Math.max(1, Math.ceil(seconds))))
  throw createError({ statusCode: 429, statusMessage: message })
}

/**
 * External API authentication with brute-force and per-key rate limits. The
 * intake page on the public port uses exactly this path.
 */
export async function requireServiceKey(event: H3Event): Promise<ServiceKey> {
  const redis = getRedis()
  const failures = 'ccm:external:auth-failures:' + hashGatewayKey(clientAddress(event)).slice(0, 32)
  const failed = Number(await redis.get(failures) || 0)
  if (failed >= EXTERNAL_AUTH_FAILURE_LIMIT) tooMany(event, Math.max(1, await redis.ttl(failures)), '验证失败次数过多，请稍后再试')
  const authorization = getHeader(event, 'authorization')
  const bearer = authorization && /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, '').trim() : null
  const secret = bearer || getHeader(event, 'x-api-key')?.trim()
  const key = secret ? await authenticateServiceKey(secret) : null
  if (!key) {
    await redis.multi().incr(failures).expire(failures, 600).exec()
    throw createError({ statusCode: 401, statusMessage: 'A valid external service key is required' })
  }
  const window = Math.floor(Date.now() / 60_000)
  const counter = `ccm:external:rate:${key.id}:${window}`
  const result = await redis.multi().incr(counter).expire(counter, 120).exec()
  const used = Number(result?.[0]?.[1] || 0)
  if (used > EXTERNAL_REQUEST_LIMIT) tooMany(event, 60 - (Date.now() / 1000) % 60, '请求过于频繁，请稍后再试')
  event.context.serviceKey = key
  return key
}

/** The service key must include the module, and the module must be running. */
export async function requireServiceKeyModule(key: ServiceKey, moduleId: string): Promise<IntakeModuleId> {
  if (!isIntakeModuleId(moduleId)) throw createError({ statusCode: 404, statusMessage: '模块不存在或不支持远程加号' })
  if (!key.moduleIds.includes(moduleId)) throw createError({ statusCode: 403, statusMessage: '此外调 Key 没有该模块的加号权限' })
  if (!await isModuleEnabled(moduleId)) throw createError({ statusCode: 503, statusMessage: '该模块已停用，请在模块管理中启用' })
  return moduleId
}
