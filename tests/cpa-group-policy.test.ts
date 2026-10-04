import { describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
const fixture = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../server/lib/cpa/client', () => ({ createCpaClient: () => ({ request: fixture.request }) }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: 'test-only-policy-secret' }) }))
import { registerCpaGroupPolicy, signCpaGroupPolicy } from '../server/lib/cpa/group-policy'
describe('private opaque kernel group policy', () => {
  it('signs only the opaque ID and expiry without disclosing the key or account identities', () => {
    const value = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.1791100000000'
    const signed = signCpaGroupPolicy('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1791100000000, 'private-salt')
    expect(signed).toBe(value + '.' + createHmac('sha256', 'private-salt').update(value).digest('hex'))
    expect(signed).not.toContain('private-salt')
  })
  it('accepts arbitrarily many server-side account IDs while keeping the inference header small', async () => {
    fixture.request.mockImplementationOnce(async ({ body }) => ({ status: 201, body: Buffer.from(JSON.stringify({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expiresAt: JSON.parse(body).expiresAt })) }))
    const token = await registerCpaGroupPolicy({ keyId: 'test-key', allowedAuthIDs: Array.from({ length: 1000 }, (_, i) => 'synthetic-auth-' + i), allowedPluginIDs: ['example-router'] })
    expect(token.length).toBeLessThan(128)
    expect(JSON.parse(fixture.request.mock.calls.at(-1)![0].body).allowedAuthIDs).toHaveLength(1000)
    expect(token).not.toContain('synthetic-auth')
  })
  it('does not fall back to unrestricted native execution on missing support or expired policies', async () => {
    fixture.request.mockResolvedValueOnce({ status: 404, body: Buffer.from('{}') })
    await expect(registerCpaGroupPolicy({ keyId: 'test', allowedAuthIDs: [], allowedPluginIDs: [] })).rejects.toMatchObject({ statusCode: 503 })
    fixture.request.mockResolvedValueOnce({ status: 200, body: Buffer.from(JSON.stringify({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expiresAt: Date.now() - 1 })) })
    await expect(registerCpaGroupPolicy({ keyId: 'test', allowedAuthIDs: [], allowedPluginIDs: [] })).rejects.toMatchObject({ statusCode: 502 })
  })
})
