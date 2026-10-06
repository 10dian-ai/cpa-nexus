import { defineEventHandler, readBody, createError } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { getDb } from '../../lib/db'
import { groupIdsSchema, setAccountGroups, assertGroupIds } from '../../lib/groups'
import { publishUpdate } from '../../lib/events'
import { validateCpaSource, prepareCpaGroupSource } from '../../lib/cpa/group-routing'
export default defineEventHandler(async event => {
  const body = validate(z.object({ moduleId: z.enum(['commandcode','cpa','devin2api']), sourceType: z.string().min(1), sourceId: z.string().min(1), groupIds: groupIdsSchema }).strict(), await readBody(event))
  if (body.sourceType !== body.moduleId) throw createError({ statusCode: 400, message: '来源类型与模块不一致' })
  if (body.moduleId === 'commandcode') {
    validate(z.string().uuid(), body.sourceId)
    await getDb().begin(async tx => {
      const rows = await tx`SELECT id FROM managed_accounts WHERE id=${body.sourceId} FOR UPDATE`
      if (!rows.length) throw createError({ statusCode: 404, message: '账号不存在' })
      await setAccountGroups(tx, body.moduleId, body.sourceId, body.groupIds)
    })
  } else if (body.moduleId === 'cpa') {
    const source = await validateCpaSource(body.sourceId)
    if (!source) throw createError({ statusCode: 404, message: 'CPA 账号来源不存在' })
    if (source.routingSupported === false) throw createError({ statusCode: 409, message: source.message || '此 CPA 账号暂不支持独立分组路由' })
    await assertGroupIds(body.groupIds)
    await prepareCpaGroupSource(body.sourceId)
    await getDb().begin(tx => setAccountGroups(tx, 'cpa', body.sourceId, body.groupIds))
  } else {
    validate(z.string().uuid(), body.sourceId)
    await getDb().begin(async tx => {
      const rows = await tx`SELECT id FROM devin2api_accounts WHERE id=${body.sourceId} FOR UPDATE`
      if (!rows.length) throw createError({ statusCode: 404, message: 'Devin 2API 账号不存在' })
      await setAccountGroups(tx, 'devin2api', body.sourceId, body.groupIds)
    })
  }
  await publishUpdate({ type: 'groups' })
  return { ok: true, groupIds: [...new Set(body.groupIds)] }
})
