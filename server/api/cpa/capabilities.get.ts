import { defineEventHandler, setHeader } from 'h3'
import { requireAdmin } from '../../lib/auth'
import { getCpaCapabilities } from '../../lib/cpa/capabilities'
export default defineEventHandler(async event => {
  await requireAdmin(event)
  setHeader(event, 'Cache-Control', 'no-store')
  return getCpaCapabilities()
})
