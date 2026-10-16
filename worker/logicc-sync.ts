import { getRedis } from '../server/lib/redis'
import { getLogiccSettings } from '../server/modules/logicc/settings'
import { accountsDueForSync } from '../server/modules/logicc/store'
import { checkAccount } from '../server/modules/logicc/sync'
import { reconcileModuleBridge } from '../server/modules/bridge-maintenance'
import { isModuleEnabled } from '../server/lib/modules'

/**
 * Periodic Logicc maintenance: refresh each account's session (keeping the
 * Clerk client alive) and re-read its model catalog, spread across the
 * configured interval. Runs under a short Redis lock so one worker does it.
 */
export async function syncLogicc(): Promise<void> {
  if (!await isModuleEnabled('logicc')) return
  const redis = getRedis()
  const token = Math.random().toString(36).slice(2)
  if (!await redis.set('ccm:logicc:sync-lock', token, 'PX', 120_000, 'NX')) return
  try {
    const settings = await getLogiccSettings()
    // Ticks run every 10 s: 36 accounts per tick, six at a time, covers ~2000
    // accounts per 10-minute interval while one tick stays well inside its lock.
    const due = await accountsDueForSync(settings.syncIntervalMinutes, 36)
    let changed = false, index = 0
    await Promise.all(Array.from({ length: Math.min(6, due.length) }, async () => {
      while (index < due.length) {
        const result = await checkAccount(due[index++]!)
        changed ||= result.ok
      }
    }))
    if (changed) await reconcileModuleBridge('logicc').catch(() => {})
  } finally {
    await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`, 1, 'ccm:logicc:sync-lock', token).catch(() => {})
  }
}
