import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'

/**
 * Account leases for module account pools, shared by every app process.
 *
 * Leases track in-flight work per account in Redis sorted sets scored by
 * expiry (Redis TIME, so all processes share one clock). Selection, cooldown
 * checks, per-account concurrency limits and reservation happen in a single
 * script, so two processes can never both take the last free slot.
 *
 * Choice: the account with the fewest in-flight leases; ties rotate through a
 * shared cursor. A limit of 0 means the account accepts unlimited parallel work.
 */
export const POOL_REDIS_PREFIX = 'ccm:pool:'
export const LEASE_MS = 60_000
export const RENEW_INTERVAL_MS = 15_000
export interface PoolKeys { global: string; cooldowns: string; cursor: string; account: (accountId: string) => string }
export function poolKeys(poolId: string): PoolKeys {
  if (!/^[a-z0-9-]{1,32}$/.test(poolId)) throw new Error('Invalid pool identifier')
  const base = POOL_REDIS_PREFIX + poolId + ':'
  return { global: base + 'leases', cooldowns: base + 'cooldowns', cursor: base + 'cursor', account: id => base + 'leases:' + id }
}

const ACQUIRE = `
local tm=redis.call('TIME')
local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local ttl=tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
local candidates=cjson.decode(ARGV[3])
local n=#candidates
if n==0 then return {'no_accounts'} end
local offset=redis.call('INCR',KEYS[3]) % n
redis.call('PEXPIRE',KEYS[3],604800000)
local best=nil
local bestScore=math.huge
local busy=0
for step=0,n-1 do
  local i=(offset+step)%n+1
  local account=candidates[i]
  local accountKey=KEYS[i+3]
  redis.call('ZREMRANGEBYSCORE',accountKey,'-inf',now)
  local cooldown=redis.call('ZSCORE',KEYS[2],account.id)
  if not cooldown or tonumber(cooldown)<=now then
    local count=redis.call('ZCARD',accountKey)
    local limit=tonumber(account.limit) or 0
    if limit>0 and count>=limit then
      busy=busy+1
    elseif count<bestScore then
      best=i
      bestScore=count
    end
  end
end
if not best then
  if busy>0 then return {'busy'} end
  return {'cooling_down'}
end
local id=candidates[best].id
local accountKey=KEYS[best+3]
local expires=now+ttl
redis.call('ZADD',KEYS[1],expires,ARGV[1])
redis.call('ZADD',accountKey,expires,ARGV[1])
redis.call('PEXPIRE',KEYS[1],ttl*2)
redis.call('PEXPIRE',accountKey,ttl*2)
return {'acquired',id,ARGV[1],tostring(expires)}
`

const RENEW = `
local tm=redis.call('TIME')
local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local a=redis.call('ZSCORE',KEYS[1],ARGV[1])
local b=redis.call('ZSCORE',KEYS[2],ARGV[1])
if not a or not b or tonumber(a)<=now or tonumber(b)<=now then
  redis.call('ZREM',KEYS[1],ARGV[1])
  redis.call('ZREM',KEYS[2],ARGV[1])
  return 0
end
local ttl=tonumber(ARGV[2])
redis.call('ZADD',KEYS[1],now+ttl,ARGV[1])
redis.call('ZADD',KEYS[2],now+ttl,ARGV[1])
redis.call('PEXPIRE',KEYS[1],ttl*2)
redis.call('PEXPIRE',KEYS[2],ttl*2)
return 1
`

const RELEASE = `
local global=redis.call('ZREM',KEYS[1],ARGV[1])
redis.call('ZREM',KEYS[2],ARGV[1])
return global
`

const COOLDOWN = `
local tm=redis.call('TIME')
local untilTime=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)+tonumber(ARGV[2])
local previous=redis.call('ZSCORE',KEYS[1],ARGV[1])
if not previous or tonumber(previous)<untilTime then
  redis.call('ZADD',KEYS[1],untilTime,ARGV[1])
end
redis.call('PEXPIRE',KEYS[1],86400000)
return 1
`

/** `limit` is the account's maximum parallel requests; 0 or absent means unlimited. */
export interface Candidate { id: string; limit?: number }
export interface Lease { poolId: string; accountId: string; token: string; expiresAt: number }
export type AcquireResult = { ok: true; lease: Lease } |
  { ok: false; reason: 'cooling_down' | 'no_accounts' | 'busy' }

export async function acquireLease(redis: Redis, poolId: string, input: { candidates: Candidate[]; leaseMs?: number }): Promise<AcquireResult> {
  const keys = poolKeys(poolId)
  const candidates = input.candidates.map(a => ({ id: a.id, limit: Math.max(0, Math.floor(a.limit ?? 0)) }))
  if (!candidates.length) return { ok: false, reason: 'no_accounts' }
  const token = randomUUID()
  const redisKeys = [keys.global, keys.cooldowns, keys.cursor, ...candidates.map(a => keys.account(a.id))]
  const result = await redis.eval(ACQUIRE, redisKeys.length, ...redisKeys, token, input.leaseMs ?? LEASE_MS, JSON.stringify(candidates)) as string[]
  if (result[0] !== 'acquired') return { ok: false, reason: result[0] as 'cooling_down' | 'no_accounts' | 'busy' }
  return { ok: true, lease: { poolId, accountId: result[1]!, token: result[2]!, expiresAt: Number(result[3]) } }
}

export async function renewLease(redis: Redis, lease: Lease, leaseMs = LEASE_MS): Promise<boolean> {
  const keys = poolKeys(lease.poolId)
  return Number(await redis.eval(RENEW, 2, keys.global, keys.account(lease.accountId), lease.token, leaseMs)) === 1
}
export async function releaseLease(redis: Redis, lease: Lease): Promise<void> {
  const keys = poolKeys(lease.poolId)
  await redis.eval(RELEASE, 2, keys.global, keys.account(lease.accountId), lease.token)
}
export async function cooldownAccount(redis: Redis, poolId: string, accountId: string, seconds: number) {
  await redis.eval(COOLDOWN, 1, poolKeys(poolId).cooldowns, accountId, Math.max(1, seconds) * 1000)
}
export async function clearCooldown(redis: Redis, poolId: string, accountId: string) {
  await redis.zrem(poolKeys(poolId).cooldowns, accountId)
}
export async function readCooldowns(redis: Redis, poolId: string, accountIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (!accountIds.length) return result
  const scores = await redis.zmscore(poolKeys(poolId).cooldowns, ...accountIds)
  const now = Date.now()
  accountIds.forEach((id, index) => { const until = Number(scores[index]); if (Number.isFinite(until) && until > now) result.set(id, until) })
  return result
}
export async function readInflightCounts(redis: Redis, poolId: string, accountIds: string[]) {
  const keys = poolKeys(poolId)
  const time = await redis.time()
  const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000)
  const pipeline = redis.pipeline()
  pipeline.zcount(keys.global, '(' + now, '+inf')
  for (const id of accountIds) pipeline.zcount(keys.account(id), '(' + now, '+inf')
  const values = await pipeline.exec()
  if (!values || values.some(([error]) => error)) throw new Error('Cannot read current pool leases')
  return { total: Number(values[0]![1]), accounts: Object.fromEntries(accountIds.map((id, i) => [id, Number(values[i + 1]![1])])) as Record<string, number> }
}

/** Keep a lease alive while a long response streams; `onLost` fires if Redis no longer holds it. */
export function startLeaseRenewal(redis: Redis, lease: Lease, onLost: () => void): () => void {
  let stopped = false
  const timer = setInterval(() => {
    void renewLease(redis, lease).then(held => { if (!held && !stopped) onLost() }).catch(() => { /* Retried on the next tick. */ })
  }, RENEW_INTERVAL_MS)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
