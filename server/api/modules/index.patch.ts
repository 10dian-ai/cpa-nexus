import { defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { platformError } from '../../lib/platform-error'
import { setModuleEnabled } from '../../lib/modules'
export default defineEventHandler(async event => {
  const input = z.object({ id: z.string().min(1).max(64), enabled: z.boolean() }).strict().safeParse(await readBody(event))
  if (!input.success) throw platformError({ statusCode: 400, message: '请提供模块 ID 和启用状态' })
  return setModuleEnabled(input.data.id, input.data.enabled)
})
