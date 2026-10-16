import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { platformError as createError } from '../../lib/platform-error'
import { z } from 'zod'
import { isPoolModuleId } from '../../../shared/modules'
import { reconcileModuleBridge } from '../../modules/bridge-maintenance'
import { setModuleEnabled } from '../../lib/modules'
export default defineEventHandler(async event => {
  const input = z.object({ enabled: z.boolean() }).strict().safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, message: '请提供模块启用状态' })
  const result = await setModuleEnabled(getRouterParam(event, 'id') || '', input.data.enabled)
  // A pool module's bridge channel in CPA follows its switch: removed when stopped, restored when started.
  if (isPoolModuleId(result.id)) void reconcileModuleBridge(result.id).catch(() => {})
  return result
})
