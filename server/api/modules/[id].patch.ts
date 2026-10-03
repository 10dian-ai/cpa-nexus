import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { platformError as createError } from '../../lib/platform-error'
import { z } from 'zod'
import { setModuleEnabled } from '../../lib/modules'
export default defineEventHandler(async event => {
  const input = z.object({ enabled: z.boolean() }).strict().safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, message: '请提供模块启用状态' })
  return setModuleEnabled(getRouterParam(event, 'id') || '', input.data.enabled)
})
