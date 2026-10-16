import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { z } from 'zod'
import { getDb } from '../../lib/db'
import { requireUuid } from '../../lib/http'
import { publishUpdate } from '../../lib/events'
import { INTAKE_MODULE_IDS } from '../../../shared/intake'
export default defineEventHandler(async event => {
  const id = requireUuid(getRouterParam(event, 'id'))
  const parsed = z.object({
    name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(),
    moduleIds: z.array(z.enum(INTAKE_MODULE_IDS)).min(1).max(INTAKE_MODULE_IDS.length).optional(),
  }).strict().safeParse(await readBody(event))
  if (!parsed.success || !Object.keys(parsed.data).length) throw createError({ statusCode: 400, statusMessage: '无效的修改内容' })
  const moduleIds = parsed.data.moduleIds ? [...new Set(parsed.data.moduleIds)] : null
  const rows = await getDb()`UPDATE service_keys SET name=coalesce(${parsed.data.name ?? null},name),enabled=coalesce(${parsed.data.enabled ?? null},enabled),
    module_ids=coalesce(${moduleIds}::text[],module_ids) WHERE id=${id} RETURNING id`
  if (!rows.length) throw createError({ statusCode: 404, statusMessage: '密钥不存在' })
  await publishUpdate({ type: 'keys' })
  return { ok: true }
})
