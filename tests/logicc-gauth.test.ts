import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The renewal dispatcher under test reaches the store and Redis; both are
// faked. The kernel itself is reached through fetch, also faked.
const fixture = vi.hoisted(() => {
  const values = new Map<string, string>()
  const locks = new Set<string>()
  return {
    values, locks,
    record: {
      id: 'ga', sessionId: null, enabled: true, status: 'needs_login',
      clientCookie: null, token: null, tokenExpiresAt: null, credentialVersion: 4,
      loginEmail: null, loginPassword: null, autoLogin: true,
      googleEmail: 'sam@gmail.com', googlePassword: 'g-pass', googleTotp: 'JBSWY3DPEHPK3PXP', googleProfile: JSON.stringify({ firstName: 'Sam', company: 'Sam Systems' }),
    } as Record<string, unknown>,
    stored: null as null | { id: string; result: Record<string, unknown>; expectedVersion: number },
    marked: [] as { status: string; error: string | null }[],
  }
})
vi.mock('../server/lib/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => fixture.values.get(key) ?? null,
    set: async (key: string, value: string, mode?: string, _ttl?: number) => {
      if (mode === 'NX') { if (fixture.locks.has(key)) return null; fixture.locks.add(key); return 'OK' }
      fixture.values.set(key, value); return 'OK'
    },
    del: async (...keys: string[]) => { for (const key of keys) { fixture.values.delete(key); fixture.locks.delete(key) } return keys.length },
    eval: async (_script: string, _n: number, key: string, token: string) => { fixture.locks.delete(key); void token; return 1 },
  }),
}))
vi.mock('../server/lib/pool/scheduler', () => ({ cooldownAccount: async () => {}, clearCooldown: async () => {} }))
vi.mock('../server/modules/logicc/store', () => ({
  loadCredential: async () => ({ ...fixture.record }),
  storeSignInResult: async (id: string, result: Record<string, unknown>, expectedVersion: number) => { fixture.stored = { id, result, expectedVersion }; return true },
  markAccountStatus: async (_id: string, status: string, error: string | null) => { fixture.marked.push({ status, error }) },
  storeRotatedCookie: async () => false,
}))
import { renewAccountSession } from '../server/modules/logicc/login'
import { gauthKernelConfig, googleAccountPayload, hasGoogleCredentials, kernelLogin } from '../server/modules/logicc/gauth'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const KERNEL = 'http://gauth-kernel.test'
const jsonResponse = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) })

beforeEach(() => { vi.stubEnv('LOGICC_GAUTH_URL', KERNEL) })
afterEach(() => { vi.unstubAllEnvs(); fetchMock.mockReset(); fixture.values.clear(); fixture.locks.clear(); fixture.stored = null; fixture.marked = [] })

describe('gauth mini-kernel configuration', () => {
  it('is absent without LOGICC_GAUTH_URL and trims a configured address', () => {
    vi.stubEnv('LOGICC_GAUTH_URL', '')
    expect(gauthKernelConfig()).toBeNull()
    vi.stubEnv('LOGICC_GAUTH_URL', ' http://gauth:8320/ ')
    expect(gauthKernelConfig()).toEqual({ url: 'http://gauth:8320', token: null })
    vi.stubEnv('LOGICC_GAUTH_TOKEN', 'sekrit')
    expect(gauthKernelConfig()!.token).toBe('sekrit')
  })
  it('requires the complete credential triple', () => {
    expect(hasGoogleCredentials({ googleEmail: 'a@b.c', googlePassword: 'p', googleTotp: 'JBSWY3DPEHPK3PXP' })).toBe(true)
    expect(hasGoogleCredentials({ googleEmail: 'a@b.c', googlePassword: 'p', googleTotp: null })).toBe(false)
  })
  it('builds the kernel payload from the record, onboarding profile included', () => {
    expect(googleAccountPayload(fixture.record as never)).toMatchObject({ label: 'sam', googleEmail: 'sam@gmail.com', googlePassword: 'g-pass', totpSecret: 'JBSWY3DPEHPK3PXP', firstName: 'Sam', company: 'Sam Systems' })
    expect(googleAccountPayload({ ...fixture.record, googleProfile: '{broken' } as never)).not.toHaveProperty('firstName')
  })
})

describe('kernelLogin outcome mapping', () => {
  it('returns the harvested session on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, name: 'sam', sessionId: 'sess_new1abc23', clientCookie: 'harvested-client' }))
    const outcome = await kernelLogin(fixture.record as never)
    expect(outcome).toMatchObject({ ok: true, sessionId: 'sess_new1abc23', clientCookie: 'harvested-client' })
    expect(fetchMock.mock.calls[0]![0]).toBe(`${KERNEL}/v1/login`)
  })
  it('passes the kernel failure reasons through', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, reason: 'needs_human', message: 'Google 安全验证' }))
    expect(await kernelLogin(fixture.record as never)).toMatchObject({ ok: false, reason: 'needs_human', message: 'Google 安全验证' })
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { ok: false, reason: 'busy', message: '正忙' }))
    expect(await kernelLogin(fixture.record as never)).toMatchObject({ ok: false, reason: 'busy' })
  })
  it('treats kernel-side trouble as transient, without echoing bodies', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { ok: false, reason: 'transient', message: 'x' }))
    expect(await kernelLogin(fixture.record as never)).toMatchObject({ ok: false, reason: 'transient', message: /服务令牌/ })
    fetchMock.mockResolvedValueOnce({ status: 500, ok: false, text: async () => 'Internal Error' })
    expect(await kernelLogin(fixture.record as never)).toMatchObject({ ok: false, reason: 'transient' })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await kernelLogin(fixture.record as never)).toMatchObject({ ok: false, reason: 'transient', message: /连接失败/ })
    vi.stubEnv('LOGICC_GAUTH_URL', '')
    expect(await kernelLogin(fixture.record as never)).toMatchObject({ ok: false, reason: 'transient', message: /未配置/ })
  })
})

describe('renewAccountSession through the gauth kernel', () => {
  it('persists a harvested session and clears the backoff', async () => {
    fixture.values.set('ccm:logicc:login-backoff:ga', 'transient')
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, sessionId: 'sess_harvest01', clientCookie: 'fresh-client' }))
    const outcome = await renewAccountSession('ga', { ignoreBackoff: true })
    expect(outcome).toMatchObject({ ok: true, sessionId: 'sess_harvest01', clientCookie: 'fresh-client' })
    expect(fixture.stored).toMatchObject({ id: 'ga', expectedVersion: 4, result: { sessionId: 'sess_harvest01', clientCookie: 'fresh-client', token: null } })
    expect(fixture.values.has('ccm:logicc:login-backoff:ga')).toBe(false)
    expect(fixture.marked).toEqual([])
  })
  it('marks the account for a human on a kernel stop, and expired on bad credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, reason: 'needs_human', message: 'Google 安全验证，需人工' }))
    expect(await renewAccountSession('ga')).toMatchObject({ ok: false, reason: 'needs_human' })
    expect(fixture.marked[0]).toMatchObject({ status: 'needs_login' })
    expect(fixture.marked[0]!.error).toContain('Google 自动登录')
    expect(fixture.values.get('ccm:logicc:login-backoff:ga')).toBe('needs_human')

    fixture.marked = []; fixture.values.clear(); fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, reason: 'bad_credentials', message: '密码不正确' }))
    expect(await renewAccountSession('ga')).toMatchObject({ ok: false, reason: 'bad_credentials' })
    expect(fixture.marked[0]).toMatchObject({ status: 'credential_expired' })
  })
  it('rests briefly on a busy kernel without touching the account status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { ok: false, reason: 'busy', message: '正忙' }))
    expect(await renewAccountSession('ga')).toMatchObject({ ok: false, reason: 'transient', message: /内核正忙/ })
    expect(fixture.marked).toEqual([])
    expect(fixture.values.get('ccm:logicc:login-backoff:ga')).toBe('busy')
  })
  it('skips accounts without usable credentials, and google accounts without a kernel', async () => {
    const saved = fixture.record
    fixture.record = { ...saved, googleEmail: null, googlePassword: null, googleTotp: null }
    expect(await renewAccountSession('ga')).toBeNull()
    fixture.record = saved
    vi.stubEnv('LOGICC_GAUTH_URL', '')
    expect(await renewAccountSession('ga')).toBeNull()
  })
  it('respects an existing backoff when not forced', async () => {
    fixture.values.set('ccm:logicc:login-backoff:ga', 'needs_human')
    expect(await renewAccountSession('ga')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
