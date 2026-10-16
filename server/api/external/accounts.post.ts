import { createError, defineEventHandler, readBody, setResponseStatus } from 'h3'
import { requireServiceKeyModule, type ServiceKey } from '../../lib/auth'
import { submitModuleIntake } from '../../lib/intake/request'

/**
 * Earlier single-module endpoint, kept for existing scripts. `moduleId` picks
 * the pool; a key scoped to exactly one module may omit it. New clients use
 * `POST /api/external/modules/{id}/accounts`.
 */
export default defineEventHandler(async event => {
  const key = event.context.serviceKey as ServiceKey
  const body = await readBody(event) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw createError({ statusCode: 400, statusMessage: '请求体必须是 JSON 对象' })
  const requested = typeof body.moduleId === 'string' ? body.moduleId : key.moduleIds.length === 1 ? key.moduleIds[0]! : ''
  if (!requested) throw createError({ statusCode: 400, statusMessage: '此 Key 可给多个模块加号，请提供 moduleId，或使用 /api/external/modules/{id}/accounts' })
  const moduleId = await requireServiceKeyModule(key, requested)
  const text = [body.text, body.token, body.cookie].filter(value => typeof value === 'string' && value.trim()).join('\n')
  const result = await submitModuleIntake(moduleId, {
    ...(text ? { text } : {}),
    ...(Array.isArray(body.items) ? { items: body.items } : {}),
    ...(Array.isArray(body.groupIds) ? { groupIds: body.groupIds as string[] } : {}),
  })
  setResponseStatus(event, result.accepted ? 202 : 200)
  return result
})
