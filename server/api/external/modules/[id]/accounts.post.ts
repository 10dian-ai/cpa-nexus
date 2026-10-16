import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { requireServiceKeyModule, type ServiceKey } from '../../../../lib/auth'
import { readIntakeRequest, submitModuleIntake } from '../../../../lib/intake/request'

/**
 * Add accounts to one module's pool. Entries are parsed now (format errors are
 * returned immediately) and imported by the worker; poll the returned job.
 */
export default defineEventHandler(async event => {
  const moduleId = await requireServiceKeyModule(event.context.serviceKey as ServiceKey, getRouterParam(event, 'id') || '')
  const result = await submitModuleIntake(moduleId, await readIntakeRequest(event))
  setResponseStatus(event, result.accepted ? 202 : 200)
  return result
})
