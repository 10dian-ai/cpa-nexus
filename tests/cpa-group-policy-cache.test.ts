import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../server/lib/cpa/client', () => ({ createCpaClient: () => ({ request: fixture.request }) }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: 'test-only-policy-secret' }) }))
import { invalidateCpaGroupPolicy, registerCpaGroupPolicy, resetCpaGroupPolicyCache } from '../server/lib/cpa/group-policy'

describe('CPA group policy registration cache', () => {
  let counter = 0
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 }); resetCpaGroupPolicyCache(); fixture.request.mockReset(); counter = 0
    fixture.request.mockImplementation(async (input: { body: string }) => {
      const { expiresAt } = JSON.parse(input.body)
      return { status: 200, body: new TextEncoder().encode(JSON.stringify({ id: String(++counter).padStart(32, '0'), expiresAt })) }
    })
  })
  afterEach(() => { vi.useRealTimers() })
  const input = { keyId: 'key', allowedAuthIDs: ['b', 'a'], allowedPluginIDs: [] }

  it('reuses an identical policy while enough validity remains', async () => {
    const first = await registerCpaGroupPolicy(input)
    expect(await registerCpaGroupPolicy({ ...input, allowedAuthIDs: ['a', 'b', 'a'] })).toBe(first)
    vi.advanceTimersByTime(19_000)
    expect(await registerCpaGroupPolicy(input)).toBe(first)
    vi.advanceTimersByTime(2_000)
    expect(await registerCpaGroupPolicy(input)).not.toBe(first)
    expect(fixture.request).toHaveBeenCalledTimes(2)
  })

  it('separates keys and source sets and re-registers after invalidation or failure', async () => {
    const first = await registerCpaGroupPolicy(input)
    expect(await registerCpaGroupPolicy({ ...input, keyId: 'other' })).not.toBe(first)
    expect(await registerCpaGroupPolicy({ ...input, allowedAuthIDs: ['a'] })).not.toBe(first)
    invalidateCpaGroupPolicy(input)
    expect(await registerCpaGroupPolicy(input)).not.toBe(first)
    fixture.request.mockResolvedValueOnce({ status: 500, body: new Uint8Array() })
    await expect(registerCpaGroupPolicy({ ...input, keyId: 'failing' })).rejects.toMatchObject({ statusCode: 503 })
    expect(await registerCpaGroupPolicy({ ...input, keyId: 'failing' })).toMatch(/^0+\d+\.\d+\.[0-9a-f]{64}$/)
  })
})
