import { defineEventHandler } from 'h3'
import { requireAdmin } from '../../lib/auth'
import { syncOfficialCatalog } from '../../lib/official-catalog'
export default defineEventHandler(async event => { await requireAdmin(event); return syncOfficialCatalog(true) })
