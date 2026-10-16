import { defineEventHandler, getRouterParam } from 'h3'
import { requireServiceKeyModule, type ServiceKey } from '../../../../lib/auth'
import { intakeHandler } from '../../../../lib/intake/request'

/** Pool counters for one module. */
export default defineEventHandler(async event => {
  const moduleId = await requireServiceKeyModule(event.context.serviceKey as ServiceKey, getRouterParam(event, 'id') || '')
  return intakeHandler(moduleId).pool()
})
