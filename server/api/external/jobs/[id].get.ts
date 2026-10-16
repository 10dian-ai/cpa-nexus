import { createError, defineEventHandler, getRouterParam } from 'h3'
import type { ServiceKey } from '../../../lib/auth'
import { getIntakeJobView } from '../../../lib/queues'
import { isIntakeModuleId } from '../../../../shared/intake'

/** Progress and result of an account import submitted with this key's modules. */
export default defineEventHandler(async event => {
  const key = event.context.serviceKey as ServiceKey
  const view = await getIntakeJobView(getRouterParam(event, 'id') || '')
  // Jobs of modules outside this key's scope are reported as missing.
  if (view.moduleId && (!isIntakeModuleId(view.moduleId) || !key.moduleIds.includes(view.moduleId))) throw createError({ statusCode: 404, statusMessage: '导入任务不存在' })
  return view
})
