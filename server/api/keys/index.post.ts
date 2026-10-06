import { randomBytes, randomUUID } from 'node:crypto'
import { defineEventHandler, readBody, createError } from 'h3'
import { z } from 'zod'
import { getDb } from '../../lib/db'
import { hashGatewayKey } from '../../lib/crypto'
import { publishUpdate } from '../../lib/events'
import { resetPresetRouteCache, saveKeyPresetMode } from '../../lib/presets'
import { groupIdsSchema, setKeyGroups, keyGroupBindings } from '../../lib/groups'
export default defineEventHandler(async event => {
  const parsed = z.object({ name: z.string().trim().min(1).max(80), moduleId: z.enum(['auto','cpa', 'commandcode', 'devin2api']).optional(), groupIds: groupIdsSchema.optional(), presetEnabled: z.boolean().default(false) }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: '请填写 1 至 80 字的密钥名称并选择有效分组' })
  const key = 'ccm_' + randomBytes(32).toString('base64url'); const id = randomUUID(); const prefix = key.slice(0, 12)
  const result = await getDb().begin(async tx => {
    const inserted = await tx`INSERT INTO gateway_keys(id,name,prefix,secret_hash,enabled,module_id) VALUES(${id},${parsed.data.name},${prefix},${hashGatewayKey(key)},true,${'auto'}) RETURNING created_at`
    await setKeyGroups(tx, id, parsed.data.groupIds)
    await saveKeyPresetMode(tx, id, parsed.data.presetEnabled)
    const binding = (await keyGroupBindings([id], tx)).get(id) ?? { groupIds: [], groupNames: [] }
    return { createdAt: inserted[0]!.created_at, binding }
  })
  resetPresetRouteCache()
  await publishUpdate({ type: 'keys' })
  return { key, item: { id, name: parsed.data.name, prefix, enabled: true, moduleId: 'auto', ...result.binding, createdAt: new Date(result.createdAt).toISOString(), lastUsedAt: null } }
})
