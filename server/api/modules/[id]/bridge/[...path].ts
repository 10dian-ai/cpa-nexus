import { defineEventHandler, getRouterParam, getHeader } from 'h3'
import type { ServerResponse } from 'node:http'
import { verifyBridgeSecret } from '../../../../lib/cpa/module-bridges'
import { verifyRouteHeaders } from '../../../../lib/bridge/identity'
import { requireModule } from '../../../../lib/modules'
import { getSettings } from '../../../../lib/settings'
import { readJsonBodyLimited } from '../../../../lib/http/transport'
import { poolModule } from '../../../../modules/registry'
import { isPoolModuleId } from '../../../../../shared/modules'

/**
 * CPA calls this back after converting a client request to Chat Completions and
 * routing the `<alias>/<model>` through a module's bridge channel. It is
 * authenticated by the module's bridge secret (Bearer) and the router's signed
 * route headers, which name the serving call group. The admin middleware
 * exempts this path, so no admin session applies.
 */
function unauthorized(res: ServerResponse) {
  res.statusCode = 401
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { message: 'Invalid module bridge call', type: 'authentication_error', code: 'bridge_unauthenticated' } }))
}

export default defineEventHandler(async event => {
  const res = event.node.res
  const moduleId = getRouterParam(event, 'id') || ''
  const path = (getRouterParam(event, 'path') || '').replace(/^v1\//, '').replace(/\/$/, '')
  if (!isPoolModuleId(moduleId)) return unauthorized(res)
  const authorization = getHeader(event, 'authorization')
  const secret = authorization && /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, '').trim() : ''
  if (!secret || !await verifyBridgeSecret(moduleId, secret)) return unauthorized(res)
  const context = verifyRouteHeaders(moduleId, event.node.req.headers as Record<string, string | string[] | undefined>)
  if (!context) return unauthorized(res)
  await requireModule(moduleId)
  if (path !== 'chat/completions' || event.method !== 'POST') {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: { message: 'Only chat/completions is served on the module bridge', type: 'invalid_request_error', code: 'unsupported_endpoint' } }))
    return
  }
  const body = await readJsonBodyLimited(event, (await getSettings()).maxRequestBodyMb * 1024 * 1024)
  await poolModule(moduleId).handleBridgeChat(event, body, { keyId: context.keyId, groupId: context.groupId, requestId: context.requestId })
})
