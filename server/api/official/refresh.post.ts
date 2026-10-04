import { defineEventHandler } from 'h3'
import { requireAdmin } from '../../lib/auth'
import { refreshOfficialAvailability } from '../../lib/official-catalog/refresh'
export default defineEventHandler(async event => { await requireAdmin(event); return refreshOfficialAvailability(true) })
