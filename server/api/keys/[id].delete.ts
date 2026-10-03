import { defineEventHandler, getRouterParam } from 'h3'
import { getDb } from '../../lib/db'
import { requireUuid } from '../../lib/http'
import { publishUpdate } from '../../lib/events'
export default defineEventHandler(async event => {
  await getDb()`DELETE FROM gateway_keys WHERE id=${requireUuid(getRouterParam(event, 'id'))} AND left(prefix,10)<>'ccm_nexus_'`
  await publishUpdate({ type: 'keys' }); return { ok: true }
})
