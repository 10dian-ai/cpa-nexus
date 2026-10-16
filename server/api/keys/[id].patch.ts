import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { z } from 'zod'
import { getDb } from '../../lib/db'
import { requireUuid } from '../../lib/http'
import { publishUpdate } from '../../lib/events'
import { groupIdsSchema, setKeyGroups, keyGroupBindings } from '../../lib/groups'
export default defineEventHandler(async event => {
  const id = requireUuid(getRouterParam(event, 'id'))
  const parsed = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(), moduleId: z.enum(['auto','cpa']).optional(), groupIds: groupIdsSchema.optional(), groupStrategy: z.enum(['failover', 'mixed']).optional() }).strict().safeParse(await readBody(event))
  if (!parsed.success || !Object.keys(parsed.data).length) throw createError({ statusCode: 400, statusMessage: '无效的修改内容' })
  const rows = await getDb().begin(async tx => {
    const updated = await tx`UPDATE gateway_keys SET name=coalesce(${parsed.data.name ?? null},name),enabled=coalesce(${parsed.data.enabled ?? null},enabled),module_id=coalesce(${parsed.data.moduleId ?? null},module_id),group_strategy=coalesce(${parsed.data.groupStrategy ?? null},group_strategy)
      WHERE id=${id} AND left(prefix,10)<>'ccm_nexus_' RETURNING id,module_id,group_strategy`
    if (!updated.length) throw createError({ statusCode: 404, statusMessage: '密钥不存在' })
    if (parsed.data.groupIds !== undefined) await setKeyGroups(tx, id, parsed.data.groupIds)
    return updated
  })
  await publishUpdate({ type: 'keys' }); return { ok: true, moduleId: rows[0]!.module_id, groupStrategy: rows[0]!.group_strategy, ...(await keyGroupBindings([id])).get(id) }
})
