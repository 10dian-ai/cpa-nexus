import { defineEventHandler } from 'h3'
import { getDb } from '../../lib/db'
import { getRedis } from '../../lib/redis'
import { bridgeState } from '../../lib/cpa/module-bridges'
import { readInflightCounts } from '../../lib/pool/scheduler'
import { LOGICC_POOL_ID } from '../../modules/logicc/config'
import { modelCoverage, summary } from '../../modules/logicc/store'
import type { LogiccOverview } from '../../../shared/logicc'

export default defineEventHandler(async (): Promise<LogiccOverview> => {
  const [accounts, models, bridge, inflight, requests] = await Promise.all([
    summary(), modelCoverage(), bridgeState('logicc'),
    readInflightCounts(getRedis(), LOGICC_POOL_ID, []).then(value => value.total).catch(() => 0),
    getDb()`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='success')::int AS success,count(*) FILTER(WHERE status='error')::int AS failed,
      count(*) FILTER(WHERE usage->'nexus'->>'usageSource'='estimated')::int AS estimated
      FROM request_logs WHERE module_id='logicc' AND created_at > now() - interval '24 hours'`,
  ])
  const r = requests[0]!
  return { accounts, inFlight: inflight, models, bridge, requests: { total: r.total, success: r.success, failed: r.failed, estimatedUsage: r.estimated } }
})
