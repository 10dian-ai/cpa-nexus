import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLease, clearCooldown, cooldownAccount, poolKeys, readCooldowns, readInflightCounts, releaseLease, renewLease } from '../server/lib/pool/scheduler'

const redisUrl = process.env.TEST_REDIS_URL
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const POOL = 'logicc'

// Real Lua and Redis expiry under a unique key prefix per test.
describe.skipIf(!redisUrl)('module pool leases (integration)', () => {
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
    let cursor = '0'
    do {
      const result = await raw.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 100)
      cursor = result[0]
      if (result[1].length) await raw.unlink(...result[1])
    } while (cursor !== '0')
    raw.disconnect(); redis.disconnect()
  })

  it('spreads concurrent requests over the least-busy accounts', async () => {
    const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const results = await Promise.all(Array.from({ length: 30 }, () => acquireLease(redis, POOL, { candidates })))
    expect(results.every(result => result.ok)).toBe(true)
    const counts = await readInflightCounts(redis, POOL, ['a', 'b', 'c'])
    expect(counts.total).toBe(30)
    expect(Object.values(counts.accounts)).toEqual([10, 10, 10])
    for (const result of results) if (result.ok) { await releaseLease(redis, result.lease); await releaseLease(redis, result.lease) }
    expect((await readInflightCounts(redis, POOL, ['a', 'b', 'c'])).total).toBe(0)
  })

  it('honours per-account concurrency limits and reports a full pool as busy', async () => {
    const candidates = [{ id: 'a', limit: 1 }, { id: 'b', limit: 2 }]
    const leases = await Promise.all(Array.from({ length: 3 }, () => acquireLease(redis, POOL, { candidates })))
    expect(leases.every(result => result.ok)).toBe(true)
    expect(await acquireLease(redis, POOL, { candidates })).toEqual({ ok: false, reason: 'busy' })
    // Limit 0 means unlimited.
    expect((await acquireLease(redis, POOL, { candidates: [{ id: 'c', limit: 0 }] })).ok).toBe(true)
  })

  it('skips cooling accounts until the cooldown ends or is cleared', async () => {
    await cooldownAccount(redis, POOL, 'a', 60)
    expect(await acquireLease(redis, POOL, { candidates: [{ id: 'a' }] })).toEqual({ ok: false, reason: 'cooling_down' })
    const other = await acquireLease(redis, POOL, { candidates: [{ id: 'a' }, { id: 'b' }] })
    expect(other.ok && other.lease.accountId).toBe('b')
    expect((await readCooldowns(redis, POOL, ['a', 'b'])).has('a')).toBe(true)
    await clearCooldown(redis, POOL, 'a')
    expect((await acquireLease(redis, POOL, { candidates: [{ id: 'a' }] })).ok).toBe(true)
  })

  it('expires abandoned leases and refuses to renew a lost one', async () => {
    const first = await acquireLease(redis, POOL, { candidates: [{ id: 'a' }], leaseMs: 300 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(await renewLease(redis, first.lease, 300)).toBe(true)
    await delay(450)
    expect((await readInflightCounts(redis, POOL, ['a'])).accounts.a).toBe(0)
    expect(await renewLease(redis, first.lease, 300)).toBe(false)
  })

  it('keeps pools apart', async () => {
    expect(poolKeys('logicc').global).not.toBe(poolKeys('other').global)
    await acquireLease(redis, 'other', { candidates: [{ id: 'a' }] })
    expect((await readInflightCounts(redis, POOL, ['a'])).total).toBe(0)
    expect(() => poolKeys('Bad Pool')).toThrow()
  })
})
