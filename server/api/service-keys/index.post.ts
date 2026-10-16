import { randomBytes, randomUUID } from 'node:crypto'
import { defineEventHandler, readBody, createError } from 'h3'
import { z } from 'zod'
import { getDb } from '../../lib/db'
import { hashGatewayKey } from '../../lib/crypto'
import { publishUpdate } from '../../lib/events'
import { INTAKE_MODULE_IDS } from '../../../shared/intake'

/** External service keys are a platform feature; each key is scoped to the modules it may add accounts to. */
export default defineEventHandler(async event => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(80),
    moduleIds: z.array(z.enum(INTAKE_MODULE_IDS)).min(1).max(INTAKE_MODULE_IDS.length).optional(),
  }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '请填写 1 至 80 字的密钥名称，并至少选择一个模块' })
  const moduleIds = [...new Set(parsed.data.moduleIds ?? INTAKE_MODULE_IDS)]
  const key = 'ccm_service_' + randomBytes(32).toString('base64url')
  const id = randomUUID(), prefix = key.slice(0, 20)
  const rows = await getDb()`INSERT INTO service_keys(id,name,prefix,secret_hash,enabled,module_ids) VALUES(${id},${parsed.data.name},${prefix},${hashGatewayKey(key)},true,${moduleIds}) RETURNING created_at`
  await publishUpdate({ type: 'keys' })
  return { key, item: { id, name: parsed.data.name, prefix, enabled: true, moduleIds, createdAt: new Date(rows[0]!.created_at).toISOString(), lastUsedAt: null } }
})
