import { defineEventHandler, readBody, createError } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { getDb } from '../../lib/db'
import { validateCpaSource } from '../../lib/cpa/group-routing'
import { publishUpdate } from '../../lib/events'
export default defineEventHandler(async event => {
  const body = validate(z.object({ moduleId: z.enum(['cpa','devin2api']), sourceType: z.string().min(1), sourceId: z.string().min(1) }).strict(), await readBody(event))
  if (body.moduleId === 'devin2api') {
    if (body.sourceType !== 'devin2api') throw createError({ statusCode: 400, message: '来源类型与模块不一致' })
    validate(z.string().uuid(), body.sourceId)
    const rows = await getDb()`DELETE FROM nexus_account_groups WHERE module_id='devin2api' AND account_id=${body.sourceId} RETURNING group_id`
    if (!rows.length) throw createError({ statusCode: 404, message: '来源分组绑定不存在' })
    await publishUpdate({ type: 'groups' })
    return { ok: true }
  }
  if (body.sourceType !== 'cpa') throw createError({ statusCode: 400, message: '来源类型与模块不一致' })
  // Refresh native inventory before dropping retained permissions; a failed read never removes bindings.
  if (await validateCpaSource(body.sourceId)) throw createError({ statusCode: 409, message: '此来源仍在 CPA 账号列表，请使用正常分组编辑' })
  const rows = await getDb()`DELETE FROM nexus_account_groups WHERE module_id='cpa' AND account_id=${body.sourceId} RETURNING group_id`
  if (!rows.length) throw createError({ statusCode: 404, message: '来源分组绑定不存在' })
  await publishUpdate({ type: 'groups' })
  return { ok: true }
})
