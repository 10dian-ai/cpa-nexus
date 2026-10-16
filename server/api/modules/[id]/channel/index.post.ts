import { createError, defineEventHandler, getRouterParam } from 'h3'
import { bridgeState } from '../../../../lib/cpa/module-bridges'
import { requireModule } from '../../../../lib/modules'
import { reconcileModuleBridge } from '../../../../modules/bridge-maintenance'
import { isPoolModuleId } from '../../../../../shared/modules'

/** Re-publish a pool module's catalog to its CPA bridge channel now. */
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id') || ''
  if (!isPoolModuleId(id)) throw createError({ statusCode: 404, statusMessage: '模块不存在' })
  await requireModule(id)
  await reconcileModuleBridge(id)
  return bridgeState(id)
})
