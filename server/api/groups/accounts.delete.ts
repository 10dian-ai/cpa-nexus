import { defineEventHandler, readBody, createError } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { getDb } from '../../lib/db'
import { validateCpaSource } from '../../lib/cpa/group-routing'
import { publishUpdate } from '../../lib/events'
export default defineEventHandler(async event => {
  const body = validate(z.object({ moduleId: z.literal('cpa'), sourceType: z.literal('cpa'), sourceId: z.string().min(1) }).strict(), await readBody(event))
  // Refresh native inventory before dropping retained permissions; a failed read never removes bindings.
  if (await validateCpaSource(body.sourceId)) throw createError({ statusCode: 409, message: '此来源仍在 CPA 账号列表，请使用正常分组编辑' })
  const rows = await getDb()`DELETE FROM nexus_account_groups WHERE module_id='cpa' AND account_id=${body.sourceId} RETURNING group_id`
  if (!rows.length) throw createError({ statusCode: 404, message: '来源分组绑定不存在' })
  await publishUpdate({ type: 'groups' })
  return { ok: true }
})
