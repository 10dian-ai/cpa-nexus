import type { DashboardView } from '../../shared/types'
import { getDb } from './db'
import { getRedis } from './redis'
import { createCpaClient } from './cpa/client'
import { findModule } from '../../shared/modules'
import { summary as logiccSummary } from '../modules/logicc/store'
import { LOGICC_POOL_ID } from '../modules/logicc/config'
import { readInflightCounts } from './pool/scheduler'
import { listCpaGroupSources } from './cpa/group-routing'

/** Platform overview: each source module's pool, the last 24 hours of requests, and service health. */
export async function getDashboardView(): Promise<DashboardView> {
  const db = getDb(); const redis = getRedis()
  const [logicc, logiccInFlight, cpaSources, requests, heartbeat, kernel] = await Promise.all([
    logiccSummary().catch(() => null),
    readInflightCounts(redis, LOGICC_POOL_ID, []).then(value => value.total).catch(() => 0),
    listCpaGroupSources().catch(() => null),
    db`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='success')::int AS success,count(*) FILTER(WHERE status='error')::int AS failed
      FROM request_logs WHERE created_at > now() - interval '24 hours'`,
    redis.get('ccm:worker:heartbeat'),
    createCpaClient().status().then(status => status.connected).catch(() => false),
  ])
  const modules: DashboardView['modules'] = []
  if (cpaSources) modules.push({ id: 'cpa', name: findModule('cpa')!.name, accounts: cpaSources.length,
    ready: cpaSources.filter(source => source.enabled).length, needsAttention: cpaSources.filter(source => source.enabled && source.routingSupported === false).length, inFlight: 0 })
  if (logicc) modules.push({ id: 'logicc', name: findModule('logicc')!.name, accounts: logicc.total, ready: logicc.ready, needsAttention: logicc.needsAttention, inFlight: logiccInFlight })
  const r = requests[0]!
  return {
    modules,
    requests: { total: r.total, success: r.success, failed: r.failed, window: '24h' },
    services: { database: true, redis: true, workerLastSeen: heartbeat, kernel },
  }
}
