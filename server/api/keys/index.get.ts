import { defineEventHandler } from 'h3'
import { getDb } from '../../lib/db'
import { keyGroupBindings } from '../../lib/groups'
export default defineEventHandler(async () => {
  const rows = await getDb()`SELECT id,name,prefix,enabled,module_id,created_at,last_used_at FROM gateway_keys
    WHERE left(prefix,10)<>'ccm_nexus_' ORDER BY created_at DESC`
  const bindings = await keyGroupBindings(rows.map(row => row.id))
  return { items: rows.map(row => ({ id: row.id, name: row.name, prefix: row.prefix, enabled: row.enabled, moduleId: row.module_id,
    ...(bindings.get(row.id) ?? { groupIds: [], groupNames: [] }),
    createdAt: new Date(row.created_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null })) }
})
