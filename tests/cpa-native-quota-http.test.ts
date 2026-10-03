import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createError, createRouter, getHeader, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ quota: vi.fn(async (input: { provider: string; auth_index: string }) => ({ provider: input.provider, authIndex: input.auth_index, raw: {}, windows: [], source: 'core-api-call', checkedAt: '2026-10-03T00:00:00.000Z' })), capabilities: vi.fn(async () => ({ connected: true, oauthProviders: [], quotaProviders: [] })) }))
vi.mock('../server/lib/auth', () => ({ requireAdmin: async (event: Parameters<typeof getHeader>[0]) => {
  if (getHeader(event, 'cookie') !== 'ccm_session=fixture-admin') throw createError({ statusCode: 401, message: '请先登录管理后台' })
  return { username: 'fixture-admin' }
} }))
vi.mock('../server/lib/cpa/quota', () => ({ queryNativeQuota: fixture.quota }))
vi.mock('../server/lib/cpa/capabilities', () => ({ getCpaCapabilities: fixture.capabilities }))
import nativeQuota from '../server/api/cpa/quota/native.post'
import capabilities from '../server/api/cpa/capabilities.get'

describe('administrator-only native capability and quota HTTP endpoints', () => {
  let server: Server, base: string
  beforeEach(async () => {
    vi.clearAllMocks()
    const router = createRouter().post('/api/cpa/quota/native', nativeQuota).get('/api/cpa/capabilities', capabilities)
    server = createServer(toNodeListener(createApp().use(router)))
    await new Promise<void>(finish => server.listen(0, '127.0.0.1', finish))
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })
  afterEach(async () => { await new Promise<void>(finish => { server.close(() => finish()); server.closeAllConnections() }) })
  it('rejects requests without an administrator session before any core or supplier operation', async () => {
    const query = await fetch(base + '/api/cpa/quota/native', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"provider":"codex","auth_index":"0123456789abcdef"}' })
    expect(query.status).toBe(401); await query.arrayBuffer()
    const discovery = await fetch(base + '/api/cpa/capabilities')
    expect(discovery.status).toBe(401); await discovery.arrayBuffer()
    expect(fixture.quota).not.toHaveBeenCalled(); expect(fixture.capabilities).not.toHaveBeenCalled()
  })
  it('accepts only the explicit bounded provider/auth-index payload and preserves no-store', async () => {
    const headers = { 'content-type': 'application/json', cookie: 'ccm_session=fixture-admin' }
    const result = await fetch(base + '/api/cpa/quota/native', { method: 'POST', headers, body: '{"provider":"codex","auth_index":"0123456789abcdef"}' })
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.json()).toMatchObject({ provider: 'codex', authIndex: '0123456789abcdef' })
    const arbitrary = await fetch(base + '/api/cpa/quota/native', { method: 'POST', headers, body: '{"provider":"codex","auth_index":"0123456789abcdef","url":"https://untrusted.invalid"}' })
    expect(arbitrary.status).toBe(400); await arbitrary.arrayBuffer()
    expect(fixture.quota).toHaveBeenCalledTimes(1)
    const oversized = await fetch(base + '/api/cpa/quota/native', { method: 'POST', headers, body: JSON.stringify({ provider: 'codex', auth_index: 'x'.repeat(5000) }) })
    expect(oversized.status).toBe(400); await oversized.arrayBuffer()
    expect(fixture.quota).toHaveBeenCalledTimes(1)
  })
})
