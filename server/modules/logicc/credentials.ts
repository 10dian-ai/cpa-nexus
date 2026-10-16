import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { getRedis } from '../../lib/redis'
import { decryptSecret, encryptSecret } from '../../lib/crypto'
import { LOGICC_ORIGIN, TOKEN_EXPIRY_MARGIN_MS, logiccClerkBase } from './config'
import { LogiccError, classifyLogiccStatus, networkFailure } from './errors'
import { loadCredential, markAccountStatus, storeRotatedCookie, type LogiccCredentialRecord } from './store'

/**
 * Logicc signs in with Clerk. A Clerk *client* (`__client` cookie on the
 * Clerk domain) can mint short-lived *session* JWTs for one of its sessions:
 *   POST {clerk}/v1/client/sessions/{sessionId}/tokens  →  { jwt }
 * Session JWTs live about a minute, so they are minted on demand, cached in
 * Redis until shortly before expiry, and refreshed by one process at a time.
 * Clerk may rotate `__client` in the response; the new value is persisted.
 */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
export function jwtExpiry(token: string): number | null {
  const exp = Number(jwtClaims(token).exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null
}
export function isFreshJwt(token: string | null | undefined, now = Date.now()): token is string {
  if (!token) return false
  const expiry = jwtExpiry(token)
  return expiry !== null && expiry - TOKEN_EXPIRY_MARGIN_MS > now
}
export function jwtSessionId(token: string): string | null {
  const sid = jwtClaims(token).sid
  return typeof sid === 'string' && /^sess_[A-Za-z0-9]+$/.test(sid) ? sid : null
}
export function looksLikeJwt(value: string): boolean {
  return /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(value)
}

/** A Clerk `__client` value: the raw cookie value, without the name or other cookies. */
export function cleanClientCookie(value: string): string {
  const text = value.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/^__client=/, '').trim()
  if (!text || text.length > 20_000 || !/^[\w.~+/=-]+$/.test(text)) throw new LogiccError('client', 400, '__client Cookie 格式不正确：请只填写 Cookie 的值')
  return text
}

function rotatedCookie(response: Response): string | null {
  const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || '']
  for (const cookie of values) {
    const match = /(?:^|,\s*)__client=([^;]+)/.exec(cookie)
    if (match?.[1]) { try { return cleanClientCookie(match[1]) } catch { /* Ignore an unusable value. */ } }
  }
  return null
}

async function clerkFetch(path: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const base = logiccClerkBase()
  try {
    return await fetch(base + path, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 20_000) })
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError') throw new LogiccError('network', 504, 'Clerk 会话服务响应超时')
    throw networkFailure(error, new URL(base).hostname)
  }
}

/** Mint a session JWT from a Clerk client cookie. */
export async function mintSessionJwt(sessionId: string, clientCookie: string): Promise<{ jwt: string; cookie: string | null }> {
  const response = await clerkFetch(`/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens`, {
    method: 'POST', headers: { cookie: `__client=${clientCookie}`, origin: LOGICC_ORIGIN, accept: 'application/json' },
  })
  const cookie = rotatedCookie(response)
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    // Clerk answers 401/403/404 for revoked, ended or foreign sessions.
    const failure = response.status === 404 || response.status === 422
      ? new LogiccError('credential', response.status, `Clerk 会话不存在或已结束（HTTP ${response.status}）`)
      : classifyLogiccStatus(response.status, text, '会话刷新')
    throw Object.assign(failure, { rotatedCookie: cookie })
  }
  let jwt = ''
  try { jwt = String((JSON.parse(text) as { jwt?: unknown }).jwt || '') } catch { /* handled below */ }
  if (!isFreshJwt(jwt) || jwtSessionId(jwt) !== sessionId) throw new LogiccError('credential', 401, 'Clerk 没有返回属于此会话的有效 JWT')
  return { jwt, cookie }
}

/**
 * Find the active session of a Clerk client, for imports that only provide
 * `__client`. Clerk's Frontend API returns the client with its sessions.
 */
export async function discoverSessionId(clientCookie: string): Promise<string> {
  const response = await clerkFetch('/v1/client', { method: 'GET', headers: { cookie: `__client=${clientCookie}`, origin: LOGICC_ORIGIN, accept: 'application/json' } })
  const text = await response.text().catch(() => '')
  if (!response.ok) throw classifyLogiccStatus(response.status, text, '会话查询')
  let payload: Record<string, any> = {}
  try { payload = JSON.parse(text) } catch { /* handled below */ }
  const client = payload?.response && typeof payload.response === 'object' ? payload.response : payload?.client && typeof payload.client === 'object' ? payload.client : payload
  const valid = (value: unknown): value is string => typeof value === 'string' && /^sess_[A-Za-z0-9]+$/.test(value)
  const sessions = Array.isArray(client?.sessions) ? client.sessions as Record<string, unknown>[] : []
  const active = sessions.filter(session => valid(session?.id) && (session.status === undefined || session.status === 'active'))
  const last = client?.last_active_session_id ?? client?.lastActiveSessionId
  if (valid(last) && active.some(session => session.id === last)) return last
  if (active.length === 1) return active[0]!.id as string
  if (valid(last)) return last
  throw new LogiccError('credential', 401, active.length > 1 ? '__client 下有多个登录会话，请同时提供 Session ID' : '__client 没有可用的登录会话，请重新登录 Logicc 后再导入')
}

const tokenKey = (id: string) => `ccm:logicc:jwt:${id}`
const lockKey = (id: string) => `ccm:logicc:refresh-lock:${id}`
async function cachedToken(id: string): Promise<string | null> {
  const value = await getRedis().get(tokenKey(id))
  if (!value) return null
  try { const token = decryptSecret(value); return isFreshJwt(token) ? token : null } catch { return null }
}
async function cacheToken(id: string, token: string) {
  const ttl = (jwtExpiry(token) ?? 0) - TOKEN_EXPIRY_MARGIN_MS - Date.now()
  if (ttl > 1000) await getRedis().set(tokenKey(id), encryptSecret(token), 'PX', ttl)
}
export async function forgetToken(id: string) { await getRedis().del(tokenKey(id)) }

async function refreshWithLock(record: LogiccCredentialRecord): Promise<string> {
  const redis = getRedis()
  const token = randomUUID()
  const deadline = Date.now() + 25_000
  while (true) {
    if (await redis.set(lockKey(record.id), token, 'PX', 30_000, 'NX')) break
    // Another process is refreshing this session: use its result.
    await sleep(100)
    const shared = await cachedToken(record.id)
    if (shared) return shared
    if (Date.now() > deadline) throw new LogiccError('network', 503, 'Logicc 会话刷新排队超时，请稍后重试')
  }
  try {
    const shared = await cachedToken(record.id)
    if (shared) return shared
    // Re-read: another process may have stored a rotated cookie meanwhile.
    const latest = (await loadCredential(record.id)) ?? record
    if (!latest.clientCookie) throw new LogiccError('credential', 401, '账号没有 __client Cookie，无法自动续期')
    try {
      const minted = await mintSessionJwt(latest.sessionId, latest.clientCookie)
      if (minted.cookie && minted.cookie !== latest.clientCookie) await storeRotatedCookie(latest.id, minted.cookie, latest.credentialVersion)
      await cacheToken(latest.id, minted.jwt)
      return minted.jwt
    } catch (error) {
      const rotated = (error as { rotatedCookie?: string | null }).rotatedCookie
      if (rotated && rotated !== latest.clientCookie) await storeRotatedCookie(latest.id, rotated, latest.credentialVersion).catch(() => false)
      throw error
    }
  } finally {
    await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`, 1, lockKey(record.id), token).catch(() => {})
  }
}

/**
 * A usable session JWT for the account. `force` skips caches after Logicc
 * rejected the previous token. Credential failures mark the account so it
 * leaves the pool until an administrator provides new credentials.
 */
export async function accountToken(id: string, options: { force?: boolean } = {}): Promise<string> {
  if (!options.force) {
    const cached = await cachedToken(id)
    if (cached) return cached
  }
  const record = await loadCredential(id)
  if (!record) throw new LogiccError('credential', 404, '账号不存在')
  try {
    if (!record.clientCookie) {
      if (!options.force && isFreshJwt(record.token)) return record.token
      throw new LogiccError('credential', 401, 'Session JWT 已过期，请补充 __client Cookie 以自动续期，或更新 JWT')
    }
    if (options.force) await forgetToken(id)
    return await refreshWithLock(record)
  } catch (error) {
    if (error instanceof LogiccError && error.kind === 'credential') await markAccountStatus(id, 'credential_expired', error.message).catch(() => {})
    throw error
  }
}
