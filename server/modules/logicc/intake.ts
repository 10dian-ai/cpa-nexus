import { createHash } from 'node:crypto'
import type { IntakeHandler, IntakeItem, ParsedIntake } from '../../lib/intake/contract'
import { isCookieExport, splitIntake } from '../../lib/intake/contract'
import type { IntakeRequest } from '../../../shared/intake'
import { cleanClientCookie, discoverSessionId, isFreshJwt, jwtClaims, jwtExpiry, jwtSessionId, looksLikeJwt } from './credentials'
import { LogiccError } from './errors'
import { getLogiccSettings } from './settings'
import { listAccounts, maskSession, modelCoverage, summary, upsertAccount } from './store'
import { checkAccount } from './sync'

/**
 * Accepted Logicc credential inputs. Every form resolves to a Clerk session ID
 * plus a `__client` cookie (refreshable) and/or a session JWT (until expiry):
 *
 *  - logicc2api JSON: `{ name, clientCookie, sessionId, token, enabled }`, as an
 *    array, `{ accounts: [...] }`, a single object or JSON lines
 *  - browser cookie exports: `[{ name: "__client", value, domain }, …]`
 *  - Cookie headers: `__client=…; __session=eyJ…` (with or without `Cookie:`)
 *  - separated lines: `client----sess_…`, `name|client|sess_…`, tab/space/comma separated
 *  - a session JWT alone (`eyJ…`, carries its session ID in `sid`)
 *  - `__client` alone: the active session is looked up from Clerk on import
 */
type Json = Record<string, unknown>
export interface LogiccCredentialInput { label: string; clientCookie: string | null; sessionId: string | null; token: string | null; enabled: boolean; maxConcurrency?: number }

const SESSION = /\bsess_[A-Za-z0-9]{8,}\b/
const pick = (value: Json, names: string[]) => {
  for (const name of names) {
    const item = value[name]
    if (typeof item === 'string' && item.trim()) return item.trim()
  }
  return null
}

/** A JWT with a `sid` claim is a session token; otherwise treat it as a client token. */
function isSessionJwt(token: string): boolean {
  return typeof jwtClaims(token).sid === 'string'
}

function cookieHeaderValues(header: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const part of header.replace(/^cookie:\s*/i, '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    values.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return values
}

function fromObject(value: Json): LogiccCredentialInput {
  const label = pick(value, ['name', 'label', 'email', 'remark', 'note']) || ''
  let clientCookie = pick(value, ['clientCookie', 'client_cookie', '__client', 'client', 'clientToken', 'client_token'])
  let sessionId = pick(value, ['sessionId', 'session_id', 'sid', 'session'])
  let token = pick(value, ['token', 'jwt', 'sessionToken', 'session_token', 'sessionJwt', 'session_jwt', '__session', 'accessToken', 'access_token'])
  const header = pick(value, ['cookie', 'cookies', 'Cookie'])
  if (header) {
    const cookies = cookieHeaderValues(header)
    clientCookie ??= cookies.get('__client') || null
    token ??= cookies.get('__session') || null
  }
  if (sessionId && !SESSION.test(sessionId)) sessionId = null
  const concurrency = Number(value.maxConcurrency ?? value.max_concurrency)
  return {
    label: label.slice(0, 100), clientCookie, sessionId, token, enabled: value.enabled !== false,
    ...(Number.isInteger(concurrency) && concurrency >= 0 ? { maxConcurrency: Math.min(concurrency, 1000) } : {}),
  }
}

function fromCookieExport(cookies: Json[]): LogiccCredentialInput {
  const byName = new Map(cookies.map(cookie => [String(cookie.name), String(cookie.value)]))
  return { label: '', clientCookie: byName.get('__client') || null, sessionId: null, token: byName.get('__session') || null, enabled: true }
}

function fromLine(text: string): LogiccCredentialInput {
  if (/(?:^|[;\s])__client=/.test(text) || /^cookie:/i.test(text)) {
    const cookies = cookieHeaderValues(text)
    return { label: '', clientCookie: cookies.get('__client') || null, sessionId: SESSION.exec(text)?.[0] || null, token: cookies.get('__session') || null, enabled: true }
  }
  const parts = text.split(/----|\t|\s*\|\s*|\s+|,/).map(part => part.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean)
  const result: LogiccCredentialInput = { label: '', clientCookie: null, sessionId: null, token: null, enabled: true }
  const leftovers: string[] = []
  for (const part of parts) {
    if (/^sess_[A-Za-z0-9]{8,}$/.test(part)) result.sessionId ??= part
    else if (looksLikeJwt(part)) { if (isSessionJwt(part)) result.token ??= part; else result.clientCookie ??= part }
    else if (part.length >= 24 && /^[\w.~+/=-]+$/.test(part)) result.clientCookie ??= part
    else leftovers.push(part)
  }
  if (leftovers.length) result.label = leftovers.join(' ').slice(0, 100)
  return result
}

/** Validate one credential offline (no network); fills session ID from a JWT when present. */
export function normalizeCredential(input: LogiccCredentialInput): LogiccCredentialInput & { tokenExpiresAt: number | null } {
  const clientCookie = input.clientCookie ? cleanClientCookie(input.clientCookie) : null
  let token = input.token?.trim().replace(/^__session=/, '') || null
  if (token && !looksLikeJwt(token)) throw new LogiccError('client', 400, 'Session JWT 格式不正确')
  const tokenSession = token ? jwtSessionId(token) : null
  if (token && !tokenSession) throw new LogiccError('client', 400, 'Session JWT 中没有会话 ID（sid）')
  if (input.sessionId && tokenSession && input.sessionId !== tokenSession) throw new LogiccError('client', 400, 'Session ID 与 Session JWT 不属于同一个会话')
  const sessionId = input.sessionId || tokenSession
  if (token && !isFreshJwt(token)) {
    if (!clientCookie) throw new LogiccError('client', 400, 'Session JWT 已过期；请同时提供 __client Cookie 以自动续期')
    token = null // An expired JWT adds nothing once the cookie can mint new ones.
  }
  if (!clientCookie && !token) throw new LogiccError('client', 400, '没有找到 __client Cookie 或 Session JWT')
  return { ...input, clientCookie, token, sessionId, tokenExpiresAt: token ? jwtExpiry(token) : null }
}

/** Parse one submitted entry into a queued item, or throw a LogiccError describing why it was rejected. */
function toItem(line: number, value: unknown): IntakeItem {
  const raw = typeof value === 'string' ? fromLine(value)
    : isCookieExport(value) ? fromCookieExport(value)
    : value && typeof value === 'object' && !Array.isArray(value) ? fromObject(value as Json)
    : (() => { throw new LogiccError('client', 400, '无法识别的账号格式') })()
  const normalized = normalizeCredential(raw)
  // Session may still be undiscovered (cookie-only): the fingerprint falls back to the cookie.
  const identity = normalized.sessionId || normalized.clientCookie || normalized.token || ''
  return {
    line,
    fingerprint: createHash('sha256').update('logicc:').update(identity).digest('hex'),
    payload: { label: normalized.label, clientCookie: normalized.clientCookie, sessionId: normalized.sessionId, token: normalized.token, tokenExpiresAt: normalized.tokenExpiresAt, enabled: normalized.enabled, maxConcurrency: normalized.maxConcurrency ?? null },
  }
}

export const logiccIntake: IntakeHandler = {
  id: 'logicc',
  describe() {
    return {
      id: 'logicc', name: 'Logicc', icon: 'i-ph-lightning-bold',
      description: 'Logicc 网页账号池。支持 __client Cookie、Session JWT，或 logicc2api 导出的 JSON。',
      accept: '.json,.txt,.csv',
      formats: [
        { id: 'client-session', label: '__client + Session ID', description: '从 Logicc 页面的 clerk.logicc.com Cookie 复制 __client 值，并提供 sess_ 开头的会话 ID；可自动续期。', example: '__client----sess_xxxxxxxx' },
        { id: 'cookie-header', label: 'Cookie 请求头', description: '直接粘贴浏览器的 Cookie，可包含 __client 与 __session。', example: '__client=…; __session=eyJ…' },
        { id: 'jwt', label: 'Session JWT', description: '仅提供一个会话 JWT，过期前有效；建议配合 __client 以便续期。', example: 'eyJhbGciOi…' },
        { id: 'json', label: 'logicc2api JSON', description: '数组或 {accounts:[…]}，字段 name / clientCookie / sessionId / token / enabled。', example: '[{"name":"账号1","clientCookie":"…","sessionId":"sess_…"}]' },
      ],
    }
  },
  parse(request: IntakeRequest): ParsedIntake {
    const items: IntakeItem[] = []
    const errors: ParsedIntake['errors'] = []
    const seen = new Set<string>()
    for (const segment of splitIntake(request)) {
      try {
        const item = toItem(segment.line, segment.value)
        if (seen.has(item.fingerprint)) continue
        seen.add(item.fingerprint)
        items.push(item)
      } catch (error) {
        errors.push({ line: segment.line, message: error instanceof LogiccError ? error.message : '账号格式不正确' })
      }
    }
    return { items, errors }
  },
  async process(payload, options) {
    const settings = await getLogiccSettings()
    let sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
    const clientCookie = typeof payload.clientCookie === 'string' ? payload.clientCookie : null
    const token = typeof payload.token === 'string' ? payload.token : null
    // Cookie-only imports resolve the active session now, against Logicc.
    if (!sessionId && clientCookie) sessionId = await discoverSessionId(clientCookie)
    if (!sessionId) throw new LogiccError('credential', 400, '无法确定账号的会话 ID')
    const { id, created } = await upsertAccount({
      sessionId, clientCookie, token,
      tokenExpiresAt: typeof payload.tokenExpiresAt === 'number' ? payload.tokenExpiresAt : null,
      label: typeof payload.label === 'string' ? payload.label : '',
      enabled: payload.enabled !== false,
      maxConcurrency: typeof payload.maxConcurrency === 'number' ? payload.maxConcurrency : settings.defaultMaxConcurrency,
    }, options.groupIds)
    // Verify immediately so the account is usable (or flagged) without waiting for the worker.
    const check = await checkAccount(id, { fresh: true })
    return { result: created ? 'imported' : 'updated', ...(check.ok ? {} : { warning: check.error || '账号检测失败' }) }
  },
  async listAccounts(query) {
    const { items, total } = await listAccounts({ q: query.q, page: query.page, pageSize: query.pageSize })
    return {
      total,
      items: items.map(account => ({
        id: account.id, label: account.label, session: account.sessionHint, status: account.status,
        enabled: account.enabled, credentialKind: account.credentialKind, models: account.models.length,
        groups: account.groupNames, inFlight: account.inFlight, lastUsedAt: account.lastUsedAt, createdAt: account.createdAt,
      })),
    }
  },
  async pool() {
    const [counts, models] = await Promise.all([summary(), modelCoverage()])
    return { module: 'logicc', accounts: counts, models }
  },
}

export { maskSession }
