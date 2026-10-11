import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLease, releaseLease, renewLease, readInflightCounts, cooldownAccount, accountLeaseKey, type Lease } from '../server/lib/gateway/scheduler'

const redisUrl = process.env.TEST_REDIS_URL
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// These tests exercise real Lua and Redis expiry. Unique key prefixes prevent
// modification of application data even when several test suites share Redis.
describe.skipIf(!redisUrl)('Redis concurrency leases (integration)', () => {
  let raw: Redis
  let redis: Redis
  let prefix: string
  beforeEach(async () => {
    prefix = 'ccm-test:' + randomUUID() + ':'
    raw = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    redis = new Redis(redisUrl!, { lazyConnect: true, keyPrefix: prefix, maxRetriesPerRequest: 1 })
    await Promise.all([raw.connect(), redis.connect()])
  })
  afterEach(async () => {
    if (raw) {
      let cursor = '0'
      do {
        const result = await raw.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 100)
        cursor = result[0]
        if (result[1].length) await raw.unlink(...result[1])
      } while (cursor !== '0')
    }
    raw?.disconnect()
    redis?.disconnect()
  })
  const options = (candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]) =>
    ({ candidates, affinityHash: null, affinityTtlSeconds: 60 })

  it('never refuses work for capacity and spreads simultaneous requests by load', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => acquireLease(redis, options())))
    expect(results.every(result => result.ok)).toBe(true)
    const leases = results.map(result => (result as { ok: true; lease: Lease }).lease)
    const counts = await readInflightCounts(redis, ['a', 'b', 'c'])
    expect(counts.total).toBe(40)
    const values = Object.values(counts.accounts)
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
    await Promise.all(leases.flatMap(lease => [releaseLease(redis, lease), releaseLease(redis, lease)]))
    expect((await readInflightCounts(redis, ['a', 'b', 'c'])).total).toBe(0)
  })
  it('renews long-running work beyond its initial expiry', async () => {
    const input = { ...options([{ id: 'a' }]), leaseMs: 600 }
    const first = await acquireLease(redis, input)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await delay(300)
    expect(await renewLease(redis, first.lease, 600)).toBe(true)
    await delay(400)
    expect((await readInflightCounts(redis, ['a'])).accounts.a).toBe(1)
    await releaseLease(redis, first.lease)
    expect((await readInflightCounts(redis, ['a'])).accounts.a).toBe(0)
  })
  it('reclaims an expired crashed request, without stale release deleting its replacement', async () => {
    const input = { ...options([{ id: 'a' }]), leaseMs: 80 }
    const first = await acquireLease(redis, input)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await delay(140)
    const second = await acquireLease(redis, { ...input, leaseMs: 2000 })
    expect(second.ok).toBe(true)
    expect(await renewLease(redis, first.lease, 2000)).toBe(false)
    await releaseLease(redis, first.lease)
    expect((await readInflightCounts(redis, ['a'])).accounts.a).toBe(1)
  })
  it('keeps a session on its account even while that account is busy', async () => {
    const input = { ...options([{ id: 'a' }, { id: 'b' }]), affinityHash: 'same-session' }
    const first = await acquireLease(redis, input)
    const second = await acquireLease(redis, input)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.lease.accountId).toBe(first.lease.accountId)
    expect((await readInflightCounts(redis, ['a', 'b'])).total).toBe(2)
  })
  it('fails closed when either half of a lease disappears', async () => {
    const result = await acquireLease(redis, options([{ id: 'a' }]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await redis.del(accountLeaseKey('a'))
    expect(await renewLease(redis, result.lease)).toBe(false)
    expect((await readInflightCounts(redis, ['a'])).total).toBe(0)
  })
  it('temporarily excludes an account without marking its model denied', async () => {
    await cooldownAccount(redis, 'a', 1)
    const input = options([{ id: 'a' }, { id: 'b' }])
    const result = await acquireLease(redis, input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.lease.accountId).toBe('b')
    expect(await acquireLease(redis, options([{ id: 'a' }]))).toEqual({ ok: false, reason: 'cooling_down' })
  })
})
