import { createHash } from 'node:crypto'
import type { IntakeHandler, IntakeItem, ParsedIntake } from '../../lib/intake/contract'
import { isCookieExport, splitIntake } from '../../lib/intake/contract'
import type { IntakeRequest } from '../../../shared/intake'
import { cleanClientCookie, discoverSessionId, isFreshJwt, jwtClaims, jwtExpiry, jwtSessionId, looksLikeJwt } from './credentials'
import { LogiccError, invalidRequest } from './errors'
import { getLogiccSettings } from './settings'
import { googleEmailHash, listAccounts, loginEmailHash, maskSession, modelCoverage, summary, upsertAccount, upsertGoogleAccount, upsertPasswordAccount } from './store'
import { renewAccountSession } from './login'
import { checkAccount } from './sync'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const isEmail = (value: string) => EMAIL.test(value) && value.length <= 254
/** RFC 4648 Base32, as TOTP secrets are written (16–64 chars, spaces already stripped). */
const isTotpSecret = (value: string) => /^[A-Z2-7]{16,64}=*$/i.test(value)

/**
 * Accepted Logicc credential inputs. Every form resolves to a Clerk session ID
 * plus a `__client` cookie (refreshable) and/or a session JWT (until expiry):
 *
 *  - logicc2api JSON: `{ name, clientCookie, sessionId, token, enabled }`, as an
 *    array, `{ accounts: [...] }`, a single object or JSON lines
 *  - gauth account JSON: `{ googleEmail, googlePassword, totpSecret, … }`
 *  - browser cookie exports: `[{ name: "__client", value, domain }, …]`
 *  - Cookie headers: `__client=…; __session=eyJ…` (with or without `Cookie:`)
 *  - separated lines: `client----sess_…`, `name|client|sess_…`, tab/space/comma separated
 *  - a session JWT alone (`eyJ…`, carries its session ID in `sid`)
 *  - `__client` alone: the active session is looked up from Clerk on import
 *  - a Google account line: `google@example.com----password----TOTPSECRET`
 *    (gauth's full form `邮箱----密码----辅助邮箱----TOTP----收件箱链接` also parses;
 *    the auxiliary email and inbox link are ignored)
 */
type Json = Record<string, unknown>
export interface LogiccCredentialInput { label: string; clientCookie: string | null; sessionId: string | null; token: string | null; loginEmail?: string | null; loginPassword?: string | null; googleEmail?: string | null; googlePassword?: string | null; googleTotp?: string | null; googleProfile?: string | null; enabled: boolean; maxConcurrency?: number }

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
  const email = pick(value, ['email', 'username', 'identifier', 'login', 'account'])
  const googleEmail = pick(value, ['googleEmail', 'google_email', 'google'])
  const label = pick(value, ['name', 'label', 'remark', 'note']) || (email && isEmail(email) ? email : googleEmail && isEmail(googleEmail) ? googleEmail : '')
  let clientCookie = pick(value, ['clientCookie', 'client_cookie', '__client', 'client', 'clientToken', 'client_token'])
  let sessionId = pick(value, ['sessionId', 'session_id', 'sid', 'session'])
  let token = pick(value, ['token', 'jwt', 'sessionToken', 'session_token', 'sessionJwt', 'session_jwt', '__session', 'accessToken', 'access_token'])
  const password = pick(value, ['password', 'pass', 'pwd', 'passwd'])
  const googlePassword = pick(value, ['googlePassword', 'google_password'])
  const googleTotp = pick(value, ['totpSecret', 'totp_secret', 'totp', 'otpSecret', 'otp_secret'])
  const firstName = pick(value, ['firstName', 'first_name'])
  const lastName = pick(value, ['lastName', 'last_name'])
  const company = pick(value, ['company', 'companyLegalName', 'company_legal_name'])
  const googleProfile = firstName || lastName || company ? JSON.stringify({ ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}), ...(company ? { company } : {}) }) : null
  const header = pick(value, ['cookie', 'cookies', 'Cookie'])
  if (header) {
    const cookies = cookieHeaderValues(header)
    clientCookie ??= cookies.get('__client') || null
    token ??= cookies.get('__session') || null
  }
  if (sessionId && !SESSION.test(sessionId)) sessionId = null
  const concurrency = Number(value.maxConcurrency ?? value.max_concurrency)
  return {
    label: label.slice(0, 100), clientCookie, sessionId, token,
    loginEmail: email && isEmail(email) ? email : null, loginPassword: password || null,
    googleEmail: googleEmail && isEmail(googleEmail) ? googleEmail : null,
    googlePassword: googlePassword || (googleTotp && password) || null,
    googleTotp: googleTotp?.replace(/\s+/g, '') || null,
    googleProfile,
    enabled: value.enabled !== false,
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
  // email + password, e.g. `user@example.com----secret` or `label----user@example.com----secret`.
  // Only when the line carries no session/cookie/JWT, so a password with odd characters is kept whole.
  if (!SESSION.test(text) && !/__client/i.test(text)) {
    const segments = text.split(/----|\t|\s*\|\s*/).map(part => part.trim().replace(/^(['"])(.*)\1$/, '$2'))
    const emailAt = segments.findIndex(part => isEmail(part))
    if (emailAt >= 0 && !segments.some(part => looksLikeJwt(part))) {
      // Google account: a Base32 TOTP secret appears after the password
      // (`email----password----TOTP`, or gauth's full form with an auxiliary
      // email and inbox link in between, which are ignored).
      const totpAt = segments.findIndex((part, index) => index > emailAt + 1 && isTotpSecret(part))
      const googlePassword = segments[emailAt + 1] || ''
      if (totpAt > 0 && googlePassword && !isEmail(googlePassword) && !/^https?:\/\//i.test(googlePassword)) {
        return { label: segments.slice(0, emailAt).join(' ').slice(0, 100), clientCookie: null, sessionId: null, token: null,
          googleEmail: segments[emailAt]!, googlePassword, googleTotp: segments[totpAt]!.replace(/\s+/g, ''), enabled: true }
      }
      const password = segments.slice(emailAt + 1).join('----').trim()
      if (password) return { label: segments.slice(0, emailAt).join(' ').slice(0, 100), clientCookie: null, sessionId: null, token: null, loginEmail: segments[emailAt]!, loginPassword: password, enabled: true }
    }
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
    if (!clientCookie && !input.loginPassword) throw new LogiccError('client', 400, 'Session JWT 已过期；请同时提供 __client Cookie 或邮箱密码以自动续期')
    token = null // An expired JWT adds nothing once the cookie or password can establish a new session.
  }
  const loginEmail = input.loginEmail?.trim() || null
  const loginPassword = input.loginPassword || null
  const googleEmail = input.googleEmail?.trim() || null
  const googlePassword = input.googlePassword || null
  const googleTotp = input.googleTotp?.replace(/\s+/g, '') || null
  const googleProfile = input.googleProfile || null
  if (loginEmail && !isEmail(loginEmail)) throw invalidRequest('登录邮箱格式不正确')
  if (loginPassword && !loginEmail) throw invalidRequest('提供了密码但没有登录邮箱')
  if (loginEmail && !loginPassword && !clientCookie && !token) throw invalidRequest('提供了登录邮箱但没有密码')
  if (loginPassword && (loginPassword.length < 1 || loginPassword.length > 256)) throw invalidRequest('登录密码长度不合法')
  if (googleEmail && !isEmail(googleEmail)) throw invalidRequest('Google 邮箱格式不正确')
  if (googlePassword && !googleEmail) throw invalidRequest('提供了 Google 密码但没有 Google 邮箱')
  if (googleTotp && !(googleEmail && googlePassword)) throw invalidRequest('提供了 TOTP 密钥但没有完整的 Google 邮箱和密码')
  if (googleEmail && !googlePassword && !clientCookie && !token) throw invalidRequest('提供了 Google 邮箱但没有密码')
  if (googlePassword && (googlePassword.length < 1 || googlePassword.length > 256)) throw invalidRequest('Google 密码长度不合法')
  if (googleTotp && !isTotpSecret(googleTotp)) throw invalidRequest('TOTP 密钥格式不正确（应为 16–64 位 Base32 字符）')
  if (!clientCookie && !token && !loginPassword && !googlePassword) throw new LogiccError('client', 400, '没有找到 __client Cookie、Session JWT、邮箱密码或 Google 凭据')
  return { ...input, clientCookie, token, sessionId, loginEmail, loginPassword, googleEmail, googlePassword, googleTotp, googleProfile, tokenExpiresAt: token ? jwtExpiry(token) : null }
}

/** Parse one submitted entry into a queued item, or throw a LogiccError describing why it was rejected. */
function toItem(line: number, value: unknown): IntakeItem {
  const raw = typeof value === 'string' ? fromLine(value)
    : isCookieExport(value) ? fromCookieExport(value)
    : value && typeof value === 'object' && !Array.isArray(value) ? fromObject(value as Json)
    : (() => { throw new LogiccError('client', 400, '无法识别的账号格式') })()
  const normalized = normalizeCredential(raw)
  // Session may still be undiscovered (cookie-, password- or Google-only): fall back to the cookie, then the login email.
  const identity = normalized.sessionId || normalized.clientCookie || normalized.token
    || (normalized.loginEmail ? 'login:' + loginEmailHash(normalized.loginEmail) : '')
    || (normalized.googleEmail ? 'google:' + googleEmailHash(normalized.googleEmail) : '')
  return {
    line,
    fingerprint: createHash('sha256').update('logicc:').update(identity).digest('hex'),
    payload: { label: normalized.label, clientCookie: normalized.clientCookie, sessionId: normalized.sessionId, token: normalized.token, loginEmail: normalized.loginEmail ?? null, loginPassword: normalized.loginPassword ?? null, googleEmail: normalized.googleEmail ?? null, googlePassword: normalized.googlePassword ?? null, googleTotp: normalized.googleTotp ?? null, googleProfile: normalized.googleProfile ?? null, tokenExpiresAt: normalized.tokenExpiresAt, enabled: normalized.enabled, maxConcurrency: normalized.maxConcurrency ?? null },
  }
}

export const logiccIntake: IntakeHandler = {
  id: 'logicc',
  describe() {
    return {
      id: 'logicc', name: 'Logicc', icon: 'i-ph-lightning-bold',
      description: 'Logicc 网页账号池。支持邮箱密码、Google 账号（OAuth 续期）、__client Cookie、Session JWT，或 logicc2api 导出的 JSON。',
      accept: '.json,.txt,.csv',
      formats: [
        { id: 'email-password', label: '邮箱 + 密码', description: '账号的登录邮箱和密码，用 ---- 分隔；会话失效时自动用它正常登录续期（遇到人机验证需你手动完成一次）。仅适用于支持密码登录的账号。', example: 'user@example.com----yourpassword' },
        { id: 'google', label: 'Google 账号（OAuth）', description: 'Google 注册账号的邮箱、密码和 TOTP 密钥，用 ---- 分隔；会话失效时由 gauth 内核自动重走 Google OAuth 收割新凭证。遇到 Google 安全验证会停下标为「待登录」，不会绕过。', example: 'user@gmail.com----gpassword----JBSWY3DPEHPK3PXP' },
        { id: 'client-session', label: '__client + Session ID', description: '从 Logicc 页面的 clerk.logicc.com Cookie 复制 __client 值，并提供 sess_ 开头的会话 ID；可自动续期。', example: '__client----sess_xxxxxxxx' },
        { id: 'cookie-header', label: 'Cookie 请求头', description: '直接粘贴浏览器的 Cookie，可包含 __client 与 __session。', example: '__client=…; __session=eyJ…' },
        { id: 'jwt', label: 'Session JWT', description: '仅提供一个会话 JWT，过期前有效；建议配合 __client 以便续期。', example: 'eyJhbGciOi…' },
        { id: 'json', label: 'logicc2api JSON', description: '数组或 {accounts:[…]}，字段 name / clientCookie / sessionId / token / email / password / enabled。', example: '[{"name":"账号1","email":"user@example.com","password":"…"}]' },
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
    const loginEmail = typeof payload.loginEmail === 'string' ? payload.loginEmail : null
    const loginPassword = typeof payload.loginPassword === 'string' ? payload.loginPassword : null
    const googleEmail = typeof payload.googleEmail === 'string' ? payload.googleEmail : null
    const googlePassword = typeof payload.googlePassword === 'string' ? payload.googlePassword : null
    const googleTotp = typeof payload.googleTotp === 'string' ? payload.googleTotp : null
    const googleProfile = typeof payload.googleProfile === 'string' ? payload.googleProfile : null
    const maxConcurrency = typeof payload.maxConcurrency === 'number' ? payload.maxConcurrency : settings.defaultMaxConcurrency
    const label = typeof payload.label === 'string' ? payload.label : ''

    // Password-only: no session yet. Add the account, then sign in to establish one.
    if (!sessionId && !clientCookie && !token && loginEmail && loginPassword) {
      const { id, created } = await upsertPasswordAccount({ loginEmail, loginPassword, label, enabled: payload.enabled !== false, maxConcurrency }, options.groupIds)
      const outcome = await renewAccountSession(id, { ignoreBackoff: true })
      if (!outcome) return { result: created ? 'imported' : 'updated', warning: '账号已保存，等待后台登录' }
      if (!outcome.ok) return { result: created ? 'imported' : 'updated', warning: outcome.message }
      const check = await checkAccount(id, { fresh: true })
      return { result: created ? 'imported' : 'updated', ...(check.ok ? {} : { warning: check.error || '登录成功但账号检测失败' }) }
    }

    // Google-only: no session yet. Add the account, then let the gauth kernel replay OAuth.
    if (!sessionId && !clientCookie && !token && googleEmail && googlePassword && googleTotp) {
      const { id, created } = await upsertGoogleAccount({ googleEmail, googlePassword, googleTotp, googleProfile, label, enabled: payload.enabled !== false, maxConcurrency }, options.groupIds)
      const outcome = await renewAccountSession(id, { ignoreBackoff: true })
      if (!outcome) return { result: created ? 'imported' : 'updated', warning: '账号已保存，等待 gauth 内核登录' }
      if (!outcome.ok) return { result: created ? 'imported' : 'updated', warning: outcome.message }
      const check = await checkAccount(id, { fresh: true })
      return { result: created ? 'imported' : 'updated', ...(check.ok ? {} : { warning: check.error || '登录成功但账号检测失败' }) }
    }

    // Cookie-only imports resolve the active session now, against Logicc.
    if (!sessionId && clientCookie) sessionId = await discoverSessionId(clientCookie)
    if (!sessionId) throw new LogiccError('credential', 400, '无法确定账号的会话 ID')
    const { id, created } = await upsertAccount({
      sessionId, clientCookie, token, loginEmail, loginPassword,
      googleEmail, googlePassword, googleTotp, googleProfile,
      tokenExpiresAt: typeof payload.tokenExpiresAt === 'number' ? payload.tokenExpiresAt : null,
      label, enabled: payload.enabled !== false, maxConcurrency,
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
