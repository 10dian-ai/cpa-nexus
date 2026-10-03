import { getRedis } from './redis'
export const UPDATE_CHANNEL = 'ccm:events'
export async function publishUpdate(event: { type: string; accountId?: string }) {
  // Notifications follow committed work. A pub/sub outage must not turn a saved
  // operation into an apparent failure (or lose a newly created one-time key).
  try { await getRedis().publish(UPDATE_CHANNEL, JSON.stringify(event)) }
  catch { console.warn('Live update notification unavailable') }
}
