import { createError, defineEventHandler, getRouterParam } from 'h3'
import { bridgeState } from '../../../../lib/cpa/module-bridges'
import { isPoolModuleId } from '../../../../../shared/modules'

/** State of a pool module's kernel-owned bridge channel in CPA. */
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id') || ''
  if (!isPoolModuleId(id)) throw createError({ statusCode: 404, statusMessage: '模块不存在' })
  return bridgeState(id)
})
