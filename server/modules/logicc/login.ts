import { randomUUID } from 'node:crypto'
import { getRedis } from '../../lib/redis'
import { browserHeaders, logiccClerkBase } from './config'
import { LogiccError, classifyLogiccStatus, describeErrorBody, looksBlocked, networkFailure } from './errors'
import { isFreshJwt, jwtExpiry, jwtSessionId } from './credentials'
import { gauthConfigured, hasGoogleCredentials, kernelLogin } from './gauth'
import { loadCredential, markAccountStatus, storeSignInResult, type LogiccCredentialRecord } from './store'

/**
 * Renew a Logicc session with the account's own stored credentials — the same
 * flows a person would run. Two kinds:
 *
 *  - `password`: a normal Clerk sign-in over HTTP (email + password).
 *  - `google`: the full Google OAuth flow (email + password + TOTP) replayed
 *    in the gauth mini-kernel's stealth browser, for accounts registered
 *    through Google that have no Logicc password.
 *
 * Both are used only to re-establish a session for an account the operator
 * owns; they never create accounts.
 *
 * If a login needs a human — a captcha/Turnstile challenge, a second factor,
 * a Google safety check — this stops and marks the account `needs_login`. It
 * never attempts to satisfy or bypass such a challenge.
 */
export type LoginSuccess = { ok: true; sessionId: string; clientCookie: string; token: string | null }
export type LoginOutcome =
  | LoginSuccess
  | { ok: false; reason: 'needs_human'; message: string }
  | { ok: false; reason: 'bad_credentials'; message: string }
  | { ok: false; reason: 'transient'; message: string }

const loginLockKey = (id: string) => `ccm:logicc:login-lock:${id}`
const loginBackoffKey = (id: string) => `ccm:logicc:login-backoff:${id}`
/** How long before the next automatic sign-in for an account, by outcome. */
const BACKOFF_SECONDS = { needs_human: 30 * 60, bad_credentials: 6 * 3600, transient: 5 * 60 } as const
/** A kernel login drives a whole browser flow: rest longer between attempts, and retry busy quickly. */
const GOOGLE_BACKOFF_SECONDS = { needs_human: 30 * 60, bad_credentials: 6 * 3600, transient: 10 * 60, busy: 2 * 60 } as const
/** The lock covers a whole browser run (see GAUTH_LOGIN_TIMEOUT_MS); a Clerk sign-in needs far less. */
const GOOGLE_LOCK_MS = 10 * 60_000

function clerkForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

/** Collect every `__client` a Clerk response sets, newest last. */
function clientCookies(response: Response): string[] {
  const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || '']
  const values: string[] = []
  for (const cookie of raw) {
    const match = /(?:^|,\s*)__client=([^;]+)/.exec(cookie)
    if (match?.[1] && match[1] !== 'undefined' && match[1].length > 20) values.push(match[1].trim())
  }
  return values
}

async function clerkPost(path: string, body: string, cookie: string | null): Promise<{ response: Response; text: string; cookie: string | null }> {
  const base = logiccClerkBase()
  let response: Response
  try {
    response = await fetch(base + path, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(25_000),
      headers: { ...browserHeaders(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(cookie ? { cookie: `__client=${cookie}` } : {}) },
      body,
    })
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError') throw new LogiccError('network', 504, 'Clerk 登录服务响应超时')
    throw networkFailure(error, new URL(base).hostname)
  }
  const text = await response.text().catch(() => '')
  return { response, text, cookie: clientCookies(response).at(-1) ?? cookie }
}

function parseClerk(text: string): { status?: string; sessionId?: string; sessionToken?: string; errorCodes: string[]; errorMessage?: string; captcha: boolean } {
  let value: any = {}
  try { value = JSON.parse(text) } catch { /* handled by caller via HTTP status */ }
  const signIn = value?.response ?? value
  const errors = Array.isArray(value?.errors) ? value.errors : []
  const errorCodes = errors.map((item: any) => String(item?.code || '')).filter(Boolean)
  const sessions = Array.isArray(value?.client?.sessions) ? value.client.sessions : []
  const token = sessions.find((session: any) => session?.last_active_token?.jwt)?.last_active_token?.jwt
  return {
    status: typeof signIn?.status === 'string' ? signIn.status : undefined,
    sessionId: typeof signIn?.created_session_id === 'string' ? signIn.created_session_id : undefined,
    sessionToken: typeof token === 'string' ? token : undefined,
    errorCodes,
    errorMessage: [errors[0]?.long_message, errors[0]?.message].find((item: unknown) => typeof item === 'string') as string | undefined,
    captcha: /captcha|turnstile|bot|challenge/i.test([...errorCodes, signIn?.status, value?.client?.captcha_bypass].join(' ')) || !!signIn?.captcha,
  }
}

const NEEDS_HUMAN = /captcha|second_factor|needs_second_factor|verification|needs_new_password|email_code|phone_code|needs_identifier/i
const BAD_CREDENTIALS = /form_password_incorrect|form_identifier_not_found|invalid|incorrect|not_found|no_account/i

/**
 * Sign in with email and password; returns the new session or why a human is needed.
 *
 * Clerk's sign-in is two steps on the Frontend API:
 *   POST /v1/client/sign_ins                              identifier=<email>  → a sign-in attempt
 *   POST /v1/client/sign_ins/{id}/attempt_first_factor    strategy=password&password=…
 * A completed attempt returns `created_session_id` and sets a fresh `__client`.
 */
export async function signInWithPassword(email: string, password: string): Promise<LoginOutcome> {
  // Step 1: create the sign-in attempt from the e-mail identifier.
  const created = await clerkPost('/v1/client/sign_ins', clerkForm({ identifier: email }), null)
  const headers = { contentType: created.response.headers.get('content-type') || '', server: created.response.headers.get('server') || '' }
  if (looksBlocked(created.text, headers.contentType, headers.server)) {
    return { ok: false, reason: 'needs_human', message: `登录被拦截（可能需要人机验证）：${describeErrorBody(created.text, headers.contentType)}` }
  }
  const first = parseClerk(created.text)
  if (first.captcha) return { ok: false, reason: 'needs_human', message: '登录需要人机验证（captcha / Turnstile），请手动完成一次登录' }
  if (!created.response.ok) {
    if (first.errorCodes.some(code => BAD_CREDENTIALS.test(code))) return { ok: false, reason: 'bad_credentials', message: first.errorMessage || '邮箱或密码不正确' }
    if (first.errorCodes.some(code => NEEDS_HUMAN.test(code))) return { ok: false, reason: 'needs_human', message: first.errorMessage || '登录需要额外验证，请手动完成一次' }
    throw classifyLogiccStatus(created.response.status, created.text, '登录', headers)
  }
  const signInId = (() => { try { return JSON.parse(created.text)?.response?.id as string } catch { return undefined } })()
  if (first.status === 'complete' && first.sessionId) return finish(first, created.cookie)
  if (!signInId) return { ok: false, reason: 'transient', message: 'Clerk 没有返回登录会话 ID' }
  if (first.status && first.status !== 'needs_first_factor') {
    // needs_second_factor, needs_identifier, needs_new_password, …
    return { ok: false, reason: 'needs_human', message: `登录需要额外验证（${first.status}），请手动完成一次` }
  }

  // Step 2: supply the password for the first factor.
  const attempt = await clerkPost(`/v1/client/sign_ins/${encodeURIComponent(signInId)}/attempt_first_factor`,
    clerkForm({ strategy: 'password', password }), created.cookie)
  const attemptHeaders = { contentType: attempt.response.headers.get('content-type') || '', server: attempt.response.headers.get('server') || '' }
  if (looksBlocked(attempt.text, attemptHeaders.contentType, attemptHeaders.server)) return { ok: false, reason: 'needs_human', message: '登录被拦截，可能需要人机验证' }
  const second = parseClerk(attempt.text)
  if (second.captcha) return { ok: false, reason: 'needs_human', message: '登录需要人机验证（captcha / Turnstile），请手动完成一次登录' }
  if (!attempt.response.ok) {
    if (second.errorCodes.some(code => BAD_CREDENTIALS.test(code))) return { ok: false, reason: 'bad_credentials', message: second.errorMessage || '邮箱或密码不正确' }
    if (second.errorCodes.some(code => NEEDS_HUMAN.test(code))) return { ok: false, reason: 'needs_human', message: second.errorMessage || '登录需要额外验证，请手动完成一次' }
    throw classifyLogiccStatus(attempt.response.status, attempt.text, '登录', attemptHeaders)
  }
  if (second.status === 'complete' && second.sessionId) return finish(second, attempt.cookie)
  if (second.status && second.status !== 'needs_first_factor') return { ok: false, reason: 'needs_human', message: `登录需要额外验证（${second.status}），请手动完成一次` }
  return { ok: false, reason: 'transient', message: '登录没有完成，请稍后重试' }

  function finish(parsed: ReturnType<typeof parseClerk>, cookie: string | null): LoginOutcome {
    if (!cookie) return { ok: false, reason: 'transient', message: '登录完成但没有收到 __client，请稍后重试' }
    const token = parsed.sessionToken && isFreshJwt(parsed.sessionToken) && jwtSessionId(parsed.sessionToken) === parsed.sessionId ? parsed.sessionToken : null
    return { ok: true, sessionId: parsed.sessionId!, clientCookie: cookie, token }
  }
}

/** Which stored credentials an account renews with, when any. */
function renewalMethod(record: LogiccCredentialRecord): 'password' | 'google' | null {
  if (record.loginEmail && record.loginPassword) return 'password'
  if (gauthConfigured() && hasGoogleCredentials(record)) return 'google'
  return null
}

/**
 * Attempt an automatic sign-in for one account, respecting a single-flight
 * lock and a per-account backoff. Persists the new session on success and sets
 * the account's status on failure. Returns the outcome (or null when it was
 * skipped: not eligible, backing off, or another worker is signing in).
 */
export async function renewAccountSession(id: string, options: { ignoreBackoff?: boolean } = {}): Promise<LoginOutcome | null> {
  const redis = getRedis()
  const record = await loadCredential(id)
  if (!record) return null
  const method = renewalMethod(record)
  if (!method) return null
  const backoff = method === 'google' ? GOOGLE_BACKOFF_SECONDS : BACKOFF_SECONDS
  if (!options.ignoreBackoff && await redis.get(loginBackoffKey(id))) return null
  const lockToken = randomUUID()
  if (!await redis.set(loginLockKey(id), lockToken, 'PX', method === 'google' ? GOOGLE_LOCK_MS : 40_000, 'NX')) return null
  try {
    // `busy` (the kernel's single browser is taken) is not a verdict on the
    // account: rest briefly and leave the status untouched.
    let outcome: LoginOutcome | null
    if (method === 'google') {
      const run = await kernelLogin(record)
      outcome = run.ok ? { ok: true, sessionId: run.sessionId, clientCookie: run.clientCookie, token: null }
        : run.reason === 'busy' ? null : { ok: false, reason: run.reason, message: run.message }
      if (outcome === null) {
        await redis.set(loginBackoffKey(id), 'busy', 'EX', GOOGLE_BACKOFF_SECONDS.busy)
        return { ok: false, reason: 'transient', message: 'gauth 内核正忙（浏览器流程单飞），稍后自动重试' }
      }
    } else {
      outcome = await signInWithPassword(record.loginEmail!, record.loginPassword!)
    }
    if (outcome.ok) {
      const stored = await storeSignInResult(id, {
        sessionId: outcome.sessionId, clientCookie: outcome.clientCookie,
        token: outcome.token, tokenExpiresAt: outcome.token ? jwtExpiry(outcome.token) : null,
      }, record.credentialVersion)
      await redis.del(loginBackoffKey(id))
      // A concurrent credential change won the race; leave it and let the next check sort it out.
      return stored ? outcome : { ok: false, reason: 'transient', message: '凭据刚刚被其他操作更新，跳过本次写入' }
    }
    await redis.set(loginBackoffKey(id), outcome.reason, 'EX', backoff[outcome.reason])
    const status = outcome.reason === 'bad_credentials' ? 'credential_expired' : 'needs_login'
    await markAccountStatus(id, status, loginStatusNote(method, outcome))
    return outcome
  } catch (error) {
    // A network or upstream failure (not a verdict on the credentials): short backoff, keep the account as is.
    await redis.set(loginBackoffKey(id), 'transient', 'EX', backoff.transient).catch(() => {})
    const message = error instanceof LogiccError ? error.message : '登录失败'
    await markAccountStatus(id, 'needs_login', `自动登录暂时失败：${message}`).catch(() => {})
    return { ok: false, reason: 'transient', message }
  } finally {
    await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`, 1, loginLockKey(id), lockToken).catch(() => {})
  }
}

function loginStatusNote(method: 'password' | 'google', outcome: LoginOutcome & { ok: false }): string {
  const flow = method === 'google' ? 'Google 自动登录' : '自动登录'
  if (outcome.reason === 'needs_human') return `${flow}需要人工完成验证：${outcome.message}（请在账号页「重新登录」，或重新导入一份 __client）`
  if (outcome.reason === 'bad_credentials') return `${flow}失败：${outcome.message}（请更新 Google 邮箱、密码或 TOTP 密钥）`
  return `${flow}暂时失败：${outcome.message}`
}

/** Whether the account can have its session renewed by signing in right now. */
export function canAutoLogin(record: LogiccCredentialRecord, autoLoginEnabled: boolean): boolean {
  return autoLoginEnabled && record.autoLogin && renewalMethod(record) !== null
}
