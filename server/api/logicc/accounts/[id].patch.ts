import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { z } from 'zod'
import { requireUuid } from '../../../lib/http'
import { publishUpdate } from '../../../lib/events'
import { getAccount, patchAccount } from '../../../modules/logicc/store'
import { reconcileModuleBridge } from '../../../modules/bridge-maintenance'

export default defineEventHandler(async event => {
  const id = requireUuid(getRouterParam(event, 'id'))
  const parsed = z.object({
    label: z.string().trim().max(100).optional(), note: z.string().max(2000).optional(), enabled: z.boolean().optional(),
    maxConcurrency: z.number().int().min(0).max(1000).optional(), groupIds: z.array(z.string().uuid()).min(1).max(50).optional(),
    autoLogin: z.boolean().optional(),
  }).strict().safeParse(await readBody(event))
  if (!parsed.success || !Object.keys(parsed.data).length) throw createError({ statusCode: 400, statusMessage: '无效的修改内容' })
  if (!await patchAccount(id, parsed.data)) throw createError({ statusCode: 404, statusMessage: '账号不存在' })
  if (parsed.data.enabled !== undefined || parsed.data.groupIds) void reconcileModuleBridge('logicc').catch(() => {})
  await publishUpdate({ type: 'accounts' })
  return getAccount(id)
})
