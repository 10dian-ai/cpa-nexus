import { createError, defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { requireModule } from '../../../lib/modules'
import { readIntakeRequest, submitModuleIntake } from '../../../lib/intake/request'
import { isIntakeModuleId } from '../../../../shared/intake'

/** Admin import: same parser, queue and worker as the external API and the public intake page. */
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id') || ''
  if (!isIntakeModuleId(id)) throw createError({ statusCode: 404, statusMessage: '模块不支持导入账号' })
  await requireModule(id)
  const result = await submitModuleIntake(id, await readIntakeRequest(event))
  setResponseStatus(event, result.accepted ? 202 : 200)
  return result
})
