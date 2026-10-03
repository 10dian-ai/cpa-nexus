import { defineEventHandler } from 'h3'
import { requireAdmin } from '../../lib/auth'
import { getOfficialCatalog } from '../../lib/official-catalog'
export default defineEventHandler(async event => { await requireAdmin(event); return getOfficialCatalog() })
