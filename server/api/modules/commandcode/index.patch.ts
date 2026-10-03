import { defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { platformError } from '../../../lib/platform-error'
import { setModuleEnabled } from '../../../lib/modules'
export default defineEventHandler(async event => {
  const input = z.object({ enabled: z.boolean() }).strict().safeParse(await readBody(event))
  if (!input.success) throw platformError({ statusCode: 400, message: '请提供模块启用状态' })
  return setModuleEnabled('commandcode', input.data.enabled)
})
