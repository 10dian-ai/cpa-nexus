import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// signInWithPassword only talks to Clerk over HTTP; no database or Redis needed.
vi.mock('../server/lib/redis', () => ({ getRedis: () => { throw new Error('no redis in this test') } }))
vi.mock('../server/lib/db', () => ({ getDb: () => { throw new Error('no db in this test') } }))
import { signInWithPassword } from '../server/modules/logicc/login'

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (sid: string) => `eyJhbGciOiJSUzI1NiJ9.${b64({ sid, exp: Math.floor(Date.now() / 1000) + 60 })}.sig`

type Reply = { status?: number; headers?: Record<string, string>; body: unknown }
describe('Logicc password sign-in against a fake Clerk', () => {
  let clerk: Server
  const received: { path: string; body: string; cookie: string }[] = []
  let signIns: Reply = { body: {} }
  let attempt: Reply = { body: {} }
  beforeAll(async () => {
    clerk = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer)
      received.push({ path: req.url!, body: Buffer.concat(chunks).toString(), cookie: String(req.headers.cookie || '') })
      const reply = req.url!.includes('/attempt_first_factor') ? attempt : signIns
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
    })
    await new Promise<void>(resolve => clerk.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('LOGICC_CLERK_BASE', `http://127.0.0.1:${(clerk.address() as AddressInfo).port}`)
  })
  afterAll(async () => { await new Promise<void>(resolve => clerk.close(() => resolve())); vi.unstubAllEnvs() })
  beforeEach(() => { received.length = 0 })

  it('signs in with the password and returns the new session and rotated __client', async () => {
    signIns = { headers: { 'set-cookie': '__client=client-step1-aaaaaaaaaaaaaaaaaaaa; Path=/; HttpOnly' }, body: { response: { id: 'sia_1', status: 'needs_first_factor', supported_first_factors: [{ strategy: 'password' }] } } }
    attempt = { headers: { 'set-cookie': '__client=client-final-bbbbbbbbbbbbbbbbbbbb; Path=/; HttpOnly' },
      body: { response: { status: 'complete', created_session_id: 'sess_signed0001' }, client: { sessions: [{ last_active_token: { jwt: jwt('sess_signed0001') } }] } } }
    const outcome = await signInWithPassword('user@example.com', 'secret-pw')
    expect(outcome).toMatchObject({ ok: true, sessionId: 'sess_signed0001', clientCookie: 'client-final-bbbbbbbbbbbbbbbbbbbb' })
    // Step 2 carries the cookie Clerk set in step 1, and sends the password form.
    expect(received[0]!.body).toContain('identifier=user%40example.com')
    expect(received[1]!.path).toContain('/sign_ins/sia_1/attempt_first_factor')
    expect(received[1]!.cookie).toContain('client-step1')
    expect(received[1]!.body).toContain('strategy=password')
  })

  it('stops at a captcha challenge and asks for a human, without a second request', async () => {
    signIns = { body: { response: { id: 'sia_2', status: 'needs_first_factor', captcha: { type: 'turnstile' } } } }
    const outcome = await signInWithPassword('user@example.com', 'secret-pw')
    expect(outcome).toMatchObject({ ok: false, reason: 'needs_human' })
    expect(received).toHaveLength(1) // never attempted the password factor
  })

  it('reports bad credentials when Clerk rejects the password', async () => {
    signIns = { body: { response: { id: 'sia_3', status: 'needs_first_factor' } } }
    attempt = { status: 422, body: { errors: [{ code: 'form_password_incorrect', message: 'Password is incorrect.' }] } }
    const outcome = await signInWithPassword('user@example.com', 'wrong')
    expect(outcome).toMatchObject({ ok: false, reason: 'bad_credentials' })
  })

  it('treats a firewall page as needing a human rather than a verdict on the password', async () => {
    signIns = { status: 403, headers: { 'content-type': 'text/html', server: 'cloudflare' }, body: '<!DOCTYPE html><title>Just a moment...</title>' }
    const outcome = await signInWithPassword('user@example.com', 'secret-pw')
    expect(outcome).toMatchObject({ ok: false, reason: 'needs_human' })
  })

  it('needs a human for a second factor', async () => {
    signIns = { body: { response: { id: 'sia_4', status: 'needs_second_factor' } } }
    const outcome = await signInWithPassword('user@example.com', 'secret-pw')
    expect(outcome).toMatchObject({ ok: false, reason: 'needs_human' })
    expect(received).toHaveLength(1)
  })
})
