import { defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { isPoolModuleId } from '../../../shared/modules'
import { reconcileModuleBridge } from '../../modules/bridge-maintenance'
import { platformError } from '../../lib/platform-error'
import { setModuleEnabled } from '../../lib/modules'
export default defineEventHandler(async event => {
  const input = z.object({ id: z.string().min(1).max(64), enabled: z.boolean() }).strict().safeParse(await readBody(event))
  if (!input.success) throw platformError({ statusCode: 400, message: '请提供模块 ID 和启用状态' })
  const result = await setModuleEnabled(input.data.id, input.data.enabled)
  // A pool module's bridge channel in CPA follows its switch: removed when stopped, restored when started.
  if (isPoolModuleId(result.id)) void reconcileModuleBridge(result.id).catch(() => {})
  return result
})
