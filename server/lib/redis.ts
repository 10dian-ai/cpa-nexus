import Redis from 'ioredis'
import { getConfig } from './config'
let redis: Redis | undefined
const connections = new Set<Redis>()
export function createRedisConnection(): Redis {
  const client = new Redis(getConfig().redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true })
  client.on('error', () => {})
  connections.add(client)
  client.on('end', () => connections.delete(client))
  return client
}
export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(getConfig().redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: 10000, enableAutoPipelining: true })
    redis.on('error', () => {})
  }
  return redis
}
export async function closeRedis(force = false) {
  const all = [...connections, ...(redis ? [redis] : [])]
  await Promise.all(all.map(async client => {
    if (force || client.status !== 'ready') { client.disconnect(); return }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        client.quit(),
        new Promise<void>(resolve => {
          timeout = setTimeout(() => { client.disconnect(); resolve() }, 5000)
          timeout.unref()
        }),
      ])
    } catch { client.disconnect() }
    finally { if (timeout) clearTimeout(timeout) }
  }))
  connections.clear(); redis = undefined
}
