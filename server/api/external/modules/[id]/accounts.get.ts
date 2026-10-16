import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { requireServiceKeyModule, type ServiceKey } from '../../../../lib/auth'
import { pagination } from '../../../../lib/http'
import { intakeHandler } from '../../../../lib/intake/request'

/** The module's accounts, without any credential material. */
export default defineEventHandler(async event => {
  const moduleId = await requireServiceKeyModule(event.context.serviceKey as ServiceKey, getRouterParam(event, 'id') || '')
  const query = getQuery(event)
  const { page, pageSize } = pagination(query)
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : undefined
  return { ...await intakeHandler(moduleId).listAccounts({ page, pageSize, q }), page, pageSize }
})
