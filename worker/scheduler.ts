import { randomUUID } from 'node:crypto'
import { getDb } from '../server/lib/db'
import { getRedis } from '../server/lib/redis'
import { getSettings } from '../server/lib/settings'
import { syncLogicc } from './logicc-sync'
import { maintainModuleBridges } from '../server/modules/bridge-maintenance'

export const WORKER_HEARTBEAT_KEY = 'ccm:worker:heartbeat'
let ticking = false

/**
 * Background maintenance: account sync for every pool module, CPA bridge-channel
 * upkeep, and request-log cleanup. A short Redis lock keeps one worker on it.
 */
export async function schedulerTick(): Promise<void> {
  if (ticking) return
  ticking = true
  const redis = getRedis(), token = randomUUID(), lock = 'ccm:worker:scheduler-lock'
  let acquired = false
  try {
    await redis.set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), 'EX', 45)
    acquired = !!await redis.set(lock, token, 'PX', 120_000, 'NX')
    if (!acquired) return
    await syncLogicc().catch(() => console.error('Logicc account sync failed'))
    // Reading CPA's channel list every tick is wasteful; every two minutes keeps it in line.
    if (await redis.set('ccm:bridges:maintenance-slot', '1', 'EX', 120, 'NX'))
      await maintainModuleBridges().catch(() => console.error('Module bridge maintenance failed'))
    if (await redis.set('ccm:logs:cleanup-slot', '1', 'EX', 3600, 'NX')) {
      const settings = await getSettings(), sql = getDb()
      let deleted = 1000
      while (deleted === 1000) {
        const result = await sql`DELETE FROM request_logs WHERE id IN (SELECT id FROM request_logs WHERE created_at < now() - (${settings.logRetentionDays} * INTERVAL '1 day') LIMIT 1000) RETURNING id`
        deleted = result.length
      }
    }
  } finally {
    if (acquired) await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`, 1, lock, token).catch(() => {})
    ticking = false
  }
}
