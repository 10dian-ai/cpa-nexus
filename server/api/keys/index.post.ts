import { randomBytes, randomUUID } from 'node:crypto'
import { defineEventHandler, readBody, createError } from 'h3'
import { z } from 'zod'
import { getDb } from '../../lib/db'
import { hashGatewayKey } from '../../lib/crypto'
import { publishUpdate } from '../../lib/events'
import { requireModule } from '../../lib/modules'
export default defineEventHandler(async event => {
  const parsed = z.object({ name: z.string().trim().min(1).max(80), moduleId: z.enum(['cpa', 'commandcode']).default('commandcode') }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '请填写 1 至 80 字的密钥名称并选择有效模型模块' })
  await requireModule(parsed.data.moduleId)
  const key = 'ccm_' + randomBytes(32).toString('base64url'); const id = randomUUID(); const prefix = key.slice(0, 12)
  const rows = await getDb()`INSERT INTO gateway_keys(id,name,prefix,secret_hash,enabled,module_id) VALUES(${id},${parsed.data.name},${prefix},${hashGatewayKey(key)},true,${parsed.data.moduleId}) RETURNING created_at`
  await publishUpdate({ type: 'keys' })
  return { key, item: { id, name: parsed.data.name, prefix, enabled: true, moduleId: parsed.data.moduleId, createdAt: new Date(rows[0]!.created_at).toISOString(), lastUsedAt: null } }
})
