import type { LogiccCredentialRecord } from './store'

/**
 * Client for the logicc-gauth mini-kernel: a sidecar service (see `gauth/`)
 * that replays the full Google OAuth flow — email → password → TOTP → consent
 * → Logicc onboarding — in a stealth browser and harvests a fresh Clerk
 * `__client` and session ID. Accounts registered through Google have no
 * Logicc password; replaying OAuth is the only way to renew their sessions.
 *
 * The kernel is optional. Without `LOGICC_GAUTH_URL` no call is ever made and
 * Google accounts simply behave like accounts without renewal credentials.
 *
 * Failure reasons match `login.ts`: `needs_human` (the kernel met a challenge
 * it must not bypass — it stopped), `bad_credentials` (the Google password or
 * TOTP secret is wrong), `transient` (timeout, kernel down, flow glitch) and
 * `busy` (another login holds the kernel's single browser; retry later).
 */
export type GauthLoginOutcome =
  | { ok: true; sessionId: string; clientCookie: string; name?: string }
  | { ok: false; reason: 'needs_human' | 'bad_credentials' | 'transient' | 'busy'; message: string }

export interface GauthKernelConfig { url: string; token: string | null }
/** Kernel address from the environment, or null when the module runs without it. */
export function gauthKernelConfig(): GauthKernelConfig | null {
  const url = process.env.LOGICC_GAUTH_URL?.trim().replace(/\/+$/, '')
  if (!url) return null
  return { url, token: process.env.LOGICC_GAUTH_TOKEN?.trim() || null }
}
export function gauthConfigured(): boolean { return gauthKernelConfig() !== null }

/** A complete Google credential: all three parts are needed to replay OAuth. */
export function hasGoogleCredentials(record: Pick<LogiccCredentialRecord, 'googleEmail' | 'googlePassword' | 'googleTotp'>): boolean {
  return !!(record.googleEmail && record.googlePassword && record.googleTotp)
}

/** The JSON the kernel expects; onboarding fields ride along when stored. */
export function googleAccountPayload(record: LogiccCredentialRecord) {
  let profile: { firstName?: string; lastName?: string; company?: string } = {}
  try { profile = record.googleProfile ? JSON.parse(record.googleProfile) : {} } catch { /* Ignore an unreadable profile. */ }
  return {
    label: record.googleEmail!.split('@')[0]!,
    googleEmail: record.googleEmail!,
    googlePassword: record.googlePassword!,
    totpSecret: record.googleTotp!,
    ...profile,
  }
}

/** One full browser login at the kernel; a run takes minutes, so the timeout is generous. */
export const GAUTH_LOGIN_TIMEOUT_MS = 9 * 60_000
export async function kernelLogin(record: LogiccCredentialRecord): Promise<GauthLoginOutcome> {
  const kernel = gauthKernelConfig()
  if (!kernel || !hasGoogleCredentials(record)) return { ok: false, reason: 'transient', message: 'gauth 内核未配置或账号缺少 Google 凭据' }
  let response: Response
  try {
    response = await fetch(`${kernel.url}/v1/login`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(GAUTH_LOGIN_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(kernel.token ? { authorization: `Bearer ${kernel.token}` } : {}) },
      body: JSON.stringify(googleAccountPayload(record)),
    })
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError') return { ok: false, reason: 'transient', message: 'gauth 内核登录超时（浏览器流程超过 9 分钟）' }
    return { ok: false, reason: 'transient', message: 'gauth 内核连接失败，请检查内核服务' }
  }
  if (response.status === 401) return { ok: false, reason: 'transient', message: 'gauth 内核拒绝了服务令牌（LOGICC_GAUTH_TOKEN 不一致）' }
  const text = await response.text().catch(() => '')
  let payload: Record<string, unknown> = {}
  try { payload = JSON.parse(text) } catch { /* handled below */ }
  const reasons = ['needs_human', 'bad_credentials', 'transient', 'busy'] as const
  const reason = reasons.find(candidate => candidate === payload.reason) ?? 'transient'
  const message = typeof payload.message === 'string' && payload.message ? payload.message : `gauth 内核返回 HTTP ${response.status}`
  if (payload.ok === true && typeof payload.sessionId === 'string' && typeof payload.clientCookie === 'string' && payload.sessionId && payload.clientCookie) {
    return { ok: true, sessionId: payload.sessionId, clientCookie: payload.clientCookie, name: typeof payload.name === 'string' ? payload.name : undefined }
  }
  return { ok: false, reason, message }
}
