import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Redis from 'ioredis'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const redisUrl = process.env.TEST_REDIS_URL
const fixture = vi.hoisted(() => ({
  redis: undefined as unknown as Redis,
  record: { id: 'acct', sessionId: 'sess_clerk00001', enabled: true, status: 'ready', clientCookie: 'client-v1' as string | null, token: null as string | null, tokenExpiresAt: null, credentialVersion: 1 },
  rotated: [] as string[], marked: [] as string[], warnings: [] as string[],
}))
vi.mock('../server/lib/redis', () => ({ getRedis: () => fixture.redis }))
vi.mock('../server/lib/crypto', () => ({ encryptSecret: (value: string) => 'enc:' + value, decryptSecret: (value: string) => value.slice(4) }))
vi.mock('../server/modules/logicc/store', () => ({
  loadCredential: async () => ({ ...fixture.record }),
  storeRotatedCookie: async (_id: string, cookie: string, version: number) => {
    if (version !== fixture.record.credentialVersion) return false
    fixture.rotated.push(cookie); fixture.record.clientCookie = cookie; fixture.record.credentialVersion++; return true
  },
  markAccountStatus: async (_id: string, status: string) => { fixture.marked.push(status) },
  noteAccountWarning: async (_id: string, message: string) => { fixture.warnings.push(message) },
}))
import { accountToken, credentialStrikes, jwtSessionId, keepSessionAlive } from '../server/modules/logicc/credentials'
import { readCooldowns } from '../server/lib/pool/scheduler'

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (sid: string, ttl = 60) => `eyJhbGciOiJSUzI1NiJ9.${b64({ sid, exp: Math.floor(Date.now() / 1000) + ttl })}.c2ln`

describe.skipIf(!redisUrl)('Logicc Clerk session refresh', () => {
  let clerk: Server
  let calls: { path: string; cookie: string; origin: string }[] = []
  let mode: 'ok' | 'revoked' | 'blocked' = 'ok'
  let prefix = ''
  beforeAll(async () => {
    clerk = createServer((req, res) => {
      calls.push({ path: req.url!, cookie: String(req.headers.cookie), origin: String(req.headers.origin) })
      if (req.url!.endsWith('/touch')) { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': '__client=client-v3; Path=/; HttpOnly' }); res.end('{}'); return }
      if (mode === 'revoked') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"errors":[{"code":"session_revoked"}]}'); return }
      if (mode === 'blocked') { res.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare' }); res.end('<!DOCTYPE html><title>Just a moment...</title>'); return }
      // Clerk rotates the client cookie on refresh.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': '__client=client-v2; Path=/; HttpOnly; Secure' })
        res.end(JSON.stringify({ jwt: jwt('sess_clerk00001') }))
      }, 50)
    })
    await new Promise<void>(resolve => clerk.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('LOGICC_CLERK_BASE', `http://127.0.0.1:${(clerk.address() as AddressInfo).port}`)
  })
  afterAll(async () => { await new Promise<void>(resolve => clerk.close(() => resolve())); vi.unstubAllEnvs() })
  beforeEach(async () => {
    prefix = 'ccm-test:' + randomUUID() + ':'
    fixture.redis = new Redis(redisUrl!, { keyPrefix: prefix, lazyConnect: true, maxRetriesPerRequest: 1 }); await fixture.redis.connect()
    fixture.record = { ...fixture.record, clientCookie: 'client-v1', token: null, credentialVersion: 1 }
    fixture.rotated = []; fixture.marked = []; fixture.warnings = []; calls = []; mode = 'ok'
  })
  afterEach(async () => {
    const raw = new Redis(redisUrl!); const keys = await raw.keys(prefix + '*'); if (keys.length) await raw.del(...keys); raw.disconnect()
    fixture.redis.disconnect()
  })

  it('mints one JWT for many concurrent callers, caches it and persists the rotated cookie once', async () => {
    const tokens = await Promise.all(Array.from({ length: 12 }, () => accountToken('acct')))
    expect(new Set(tokens).size).toBe(1)
    expect(jwtSessionId(tokens[0]!)).toBe('sess_clerk00001')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ path: '/v1/client/sessions/sess_clerk00001/tokens', cookie: '__client=client-v1', origin: 'https://app.logicc.com' })
    expect(fixture.rotated).toEqual(['client-v2'])
    expect(await accountToken('acct')).toBe(tokens[0])
    expect(calls).toHaveLength(1)
    // A forced refresh (after Logicc rejected the token) uses the rotated cookie.
    await accountToken('acct', { force: true })
    expect(calls[1]!.cookie).toBe('__client=client-v2')
  })

  it('keeps a rejected account in the pool, resting, until rejections repeat', async () => {
    mode = 'revoked'
    await expect(accountToken('acct')).rejects.toMatchObject({ kind: 'credential' })
    expect(fixture.marked).toEqual([])
    expect(fixture.warnings[0]).toContain('code=session_revoked')
    expect(fixture.warnings[0]).toContain('1/3')
    expect((await readCooldowns(fixture.redis, 'logicc', ['acct'])).has('acct')).toBe(true)
    // Concurrent requests failing together count once.
    await expect(accountToken('acct')).rejects.toMatchObject({ kind: 'credential' })
    expect(await credentialStrikes('acct')).toBe(1)
    for (let strike = 2; strike <= 3; strike++) {
      await fixture.redis.del('ccm:logicc:credential-strike-guard:acct')
      await expect(accountToken('acct')).rejects.toMatchObject({ kind: 'credential' })
    }
    expect(fixture.marked).toEqual(['credential_expired'])
  })

  it('does not count a firewall page as a rejected session', async () => {
    mode = 'blocked'
    await expect(accountToken('acct')).rejects.toMatchObject({ kind: 'upstream' })
    expect(fixture.marked).toEqual([])
    expect(await credentialStrikes('acct')).toBe(0)
  })

  it('touches the session like the web app and keeps a rotated cookie', async () => {
    await keepSessionAlive('acct')
    expect(calls.at(-1)).toMatchObject({ path: '/v1/client/sessions/sess_clerk00001/touch', cookie: '__client=client-v1' })
    expect(fixture.rotated).toEqual(['client-v3'])
  })

  it('uses a stored JWT until it expires when there is no client cookie', async () => {
    const stored = jwt('sess_clerk00001', 600)
    fixture.record = { ...fixture.record, clientCookie: null, token: stored }
    expect(await accountToken('acct')).toBe(stored)
    fixture.record = { ...fixture.record, token: jwt('sess_clerk00001', 5) }
    await expect(accountToken('acct')).rejects.toMatchObject({ kind: 'credential' })
    expect(calls).toHaveLength(0)
    // Nothing can renew it: the account leaves the pool at once.
    expect(fixture.marked).toEqual(['credential_expired'])
  })
})
