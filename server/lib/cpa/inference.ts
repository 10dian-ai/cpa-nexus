import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { getRequestURL, type H3Event } from 'h3'
import { CPA_DEFAULT_URL, validateCpaBaseUrl } from './client'
import { handleCommandcodeCompatibility } from '../commandcode-compat'
import { handleGateway } from '../gateway/handler'
import { verifyOriginalGatewayKey } from '../commandcode-identity'
import { resolveKeyPresetStack } from '../presets'
import { authenticateGatewayKey } from '../auth'
import { applyPresetStack, resolvePresetGenerationType } from '../presets/engine'
import { getSettings } from '../settings'
import { readJsonBodyLimited } from '../gateway/transport'
import { isModuleEnabled, requireModule } from '../modules'
import { gatewayCors } from '../gateway/cors'
import { resolveEnabledKeyGroupIds } from '../groups'
import { listCpaGroupModels, resolveCpaGroupPolicy } from './group-routing'
import { listCandidates, listGatewayModels } from '../gateway/accounts'
import { getProviderModel } from '../official-catalog'
import { privacyHeaders } from '../privacy-headers'
import { getConfig } from '../config'
import { CPA_GROUP_POLICY_HEADER, registerCpaGroupPolicy } from './group-policy'
import { handleDevin2ApiInference } from '../devin2api/inference'
import { listDevin2ApiGroupModels } from '../devin2api/routing'
import { BILLING_USAGE_POLICY, BILLING_USAGE_POLICY_HEADER, BillingUsageObserver, normalizeBillingRequest } from '../billing'
import { insertRequestLog } from '../logs'

const PROTOCOLS = new Map([['chat/completions', 'chat'], ['messages', 'messages'], ['responses', 'responses']] as const)
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
// Kept for callers upgrading from the former native-key authentication cache.
export function resetCpaInferenceAuthCache() {}

function copyHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionTokens = String(source.connection || '').toLowerCase().split(',').map(token => token.trim())
  return Object.fromEntries(Object.entries(source).filter(([name]) => !HOP_HEADERS.has(name) && !connectionTokens.includes(name)))
}
function destination(path: string) {
  return new URL(path, validateCpaBaseUrl(process.env.CPA_URL || CPA_DEFAULT_URL))
}
function fail(event: H3Event, protocol: string, status: number, message: string) {
  if (event.node.res.destroyed || event.node.res.writableEnded) return
  event.node.res.statusCode = status
  event.node.res.setHeader('content-type', 'application/json; charset=utf-8')
  event.node.res.end(JSON.stringify(protocol === 'messages'
    ? { type: 'error', error: { type: 'invalid_request_error', message } }
    : { error: { type: 'invalid_request_error', code: 'preset_route_error', message } }))
}

function requestHeaders(event: H3Event, clientKey?: string): IncomingHttpHeaders {
  const input = copyHeaders(event.node.req.headers)
  const hasSession = ['x-session-id', 'session_id', 'x-claude-code-session-id', 'x-codex-session-id'].some(name => typeof input[name] === 'string')
  const headers = privacyHeaders(input, hasSession ? getConfig().encryptionKey : undefined)
  for (const name of Object.keys(headers)) if (name.startsWith('x-nexus-')) delete headers[name]
  if (clientKey) {
    for (const name of Object.keys(headers)) {
      if (name === 'cookie' || name === 'x-api-key' || name === 'x-goog-api-key' || name.startsWith('x-nexus-')) delete headers[name]
    }
    headers.authorization = 'Bearer ' + clientKey
  }
  return headers
}

/** Stream native requests and replies without changing their protocol or credentials. */
export async function forwardNativeCpa(event: H3Event, path: string, body?: Record<string, unknown>, clientKey?: string, groupPolicy?: string,
  usageObserver?: BillingUsageObserver) {
  const url = destination(path)
  const headers = requestHeaders(event, clientKey)
  if (groupPolicy) headers[CPA_GROUP_POLICY_HEADER] = groupPolicy
  let transformed: Buffer | undefined
  if (body) {
    transformed = Buffer.from(JSON.stringify(body))
    headers['content-length'] = String(transformed.byteLength)
    headers['content-type'] = 'application/json'
    delete headers['content-encoding']
  }
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  await new Promise<void>((resolve, reject) => {
    let reply: IncomingMessage | undefined
    const upstream = request(url, { method: event.method, headers }, response => {
      reply = response
      event.node.res.statusCode = response.statusCode || 502
      for (const [name, value] of Object.entries(copyHeaders(response.headers))) {
        if (value !== undefined && name !== BILLING_USAGE_POLICY_HEADER) event.node.res.setHeader(name, value)
      }
      event.node.res.setHeader('x-accel-buffering', 'no')
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('CPA response interrupted')))
      if (usageObserver) {
        response.on('data', chunk => usageObserver.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on('end', () => usageObserver.end())
      }
      response.pipe(event.node.res)
    })
    const cleanup = () => { event.node.res.off('close', closed); event.node.res.off('finish', finished) }
    const finished = () => { cleanup(); resolve() }
    const closed = () => {
      if (!event.node.res.writableFinished) { upstream.destroy(); reply?.destroy() }
      cleanup(); resolve()
    }
    event.node.res.once('close', closed)
    event.node.res.once('finish', finished)
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('CPA upstream idle timeout')))
    upstream.on('error', error => { cleanup(); reject(error) })
    if (event.node.res.destroyed) { closed(); return }
    if (transformed) upstream.end(transformed)
    else event.node.req.pipe(upstream)
  })
}

async function listModelGroups(event: H3Event, keyId: string, groupIds: string[], moduleId: string) {
  const catalogs: Array<Promise<Array<{ id: string }>>> = []
  const includeCommandcode = (moduleId === 'commandcode' || moduleId === 'auto') && await isModuleEnabled('commandcode')
  const includeDevin = (moduleId === 'devin2api' || moduleId === 'auto') && await isModuleEnabled('devin2api')
  if (moduleId === 'cpa' || moduleId === 'auto') catalogs.push(listCpaGroupModels(groupIds))
  if (includeCommandcode) catalogs.push(listGatewayModels(keyId).then(result => result.data))
  if (includeDevin) catalogs.push(listDevin2ApiGroupModels(groupIds))
  const results = await Promise.allSettled(catalogs)
  if (results.every(result => result.status === 'rejected')) throw Object.assign(new Error('模型目录暂不可用'), { statusCode: 503 })
  const models = new Map<string, Record<string, unknown>>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const model of result.value) {
      const previous = models.get(model.id)
      if (!previous) models.set(model.id, { ...model })
    }
  }
  event.node.res.setHeader('content-type', 'application/json; charset=utf-8')
  event.node.res.end(JSON.stringify({ object: 'list', data: [...models.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))) }))
}

/** A platform model key grants group membership across source modules. */
export async function handleNexusInference(event: H3Event) {
  const requested = getRequestURL(event)
  const path = requested.pathname.replace(/^(?:\/nexus\/cpa)?\/v1\//, '').replace(/\/$/, '')
  const protocol = PROTOCOLS.get(path as 'chat/completions' | 'messages' | 'responses')
  const cors = gatewayCors('/v1/' + path, event.method, event.node.req.headers['access-control-request-headers'])
  if (cors) {
    for (const [name, value] of Object.entries(cors.headers)) event.node.res.setHeader(name, value)
    if (cors.preflight) { event.node.res.statusCode = 204; event.node.res.end(); return }
  }
  const authorization = event.node.req.headers.authorization
  const apiKey = event.node.req.headers['x-api-key']
  const secret = typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, '').trim() : typeof apiKey === 'string' ? apiKey.trim() : ''
  try {
    // Native CPA keys may use any non-empty value, but an absent credential
    // must be rejected at the platform boundary instead of being proxied to
    // the core and exposed as a misleading upstream 502.
    if (!secret) { fail(event, path, 401, 'A valid model API key is required'); return }
    // Existing native core keys retain their original protocol and authentication.
    if (!secret.startsWith('ccm_')) return await forwardNativeCpa(event, '/v1/' + path + requested.search)
    // CPA installations before the private app callback was split may still point
    // their managed CommandCode channel at the public /nexus/cpa/v1 route. A
    // signed bridge callback is internal and must use the same gateway path as a
    // direct /v1 callback so the original model key, groups and presets survive.
    // Require the signature before delegating; an unsigned bridge key remains an
    // invalid public model key below.
    const bridgeProtocol = protocol === 'chat' ? 'chat/completions' : protocol || (path === 'systemone' ? 'systemone' : undefined)
    if (secret.startsWith('ccm_nexus_') && bridgeProtocol && verifyOriginalGatewayKey(event.node.req.headers)) {
      return await handleGateway(event, { protocolPath: bridgeProtocol })
    }
    if (!((path === 'models' && event.method === 'GET') || ((protocol || path === 'systemone') && event.method === 'POST'))) { fail(event, path, 404, 'Unsupported model endpoint'); return }
    const key = await authenticateGatewayKey(secret)
    if (!key || secret.startsWith('ccm_nexus_')) { fail(event, path, 401, 'A valid model API key is required'); return }
    const moduleId = key.moduleId || 'commandcode'
    if (moduleId === 'commandcode') return await handleCommandcodeCompatibility(event, { protocolPath: path })
    const groupIds = await resolveEnabledKeyGroupIds(key.id)
    if (!groupIds.length) { fail(event, path, 403, '这个模型 API Key 没有已启用的分组'); return }
    if (path === 'models') return await listModelGroups(event, key.id, groupIds, moduleId)
    if (path === 'systemone') {
      if (moduleId === 'auto') return await handleCommandcodeCompatibility(event, { protocolPath: path })
      fail(event, path, 403, 'System One requires a key with Command Code group access'); return
    }
    if (event.node.req.headers['content-encoding']) { fail(event, path, 415, 'Model API keys require an uncompressed JSON request'); return }
    let body = await readJsonBodyLimited(event, (await getSettings()).maxRequestBodyMb * 1024 * 1024)
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model || model.length > 256) { fail(event, path, 400, 'model must be a non-empty string of at most 256 characters'); return }
    if (moduleId === 'devin2api' || (moduleId === 'auto' && model.startsWith('devin/'))) {
      return await handleDevin2ApiInference(event, { keyId: key.id, groupIds, protocolPath: path, body })
    }
    if (model.startsWith('devin/')) { fail(event, path, 403, 'This API key is not bound to the Devin module'); return }
    if (moduleId === 'auto') {
      if (model.startsWith('commandcode/')) return await handleCommandcodeCompatibility(event, { protocolPath: path, body })
      // Provider IDs are unambiguous for the existing CommandCode clients. Keep
      // their protocol bridge and retry pool, restricted to this same key's groups.
      if (await isModuleEnabled('commandcode')) {
        let provider: Awaited<ReturnType<typeof getProviderModel>> = null
        try { provider = await getProviderModel(model) } catch { /* CPA can remain usable during a catalog outage. */ }
        if (provider && (await listCandidates(model, key.id)).length) return await handleCommandcodeCompatibility(event, { protocolPath: path, body })
      }
    } else if (model.startsWith('commandcode/')) { fail(event, path, 403, 'This legacy key is bound to CPA'); return }
    const clientKey = process.env.CPA_CLIENT_KEY?.trim()
    if (!clientKey) { fail(event, path, 503, 'Configure CPA_CLIENT_KEY before using a unified CPA model key'); return }
    await requireModule('cpa')
    const selected = await resolveCpaGroupPolicy(model, groupIds, key.id)
    if (!selected) { fail(event, path, 404, '当前 Key 的分组中没有可调用的这个模型'); return }
    body.model = model
    const presets = await resolveKeyPresetStack(key.id, [selected.selectedGroupId])
    const generationType = resolvePresetGenerationType(body, event.node.req.headers)
    if (presets.length) {
      body = applyPresetStack(presets, body, { protocol: protocol!, generationType })
      event.node.res.setHeader('x-nexus-preset-id', presets.map(preset => preset.id).join(','))
    }
    if (Object.hasOwn(body, 'generation_type')) { body = { ...body }; delete body.generation_type }
    body = normalizeBillingRequest(body, path)
    event.node.res.setHeader(BILLING_USAGE_POLICY_HEADER, BILLING_USAGE_POLICY)
    body.model = selected.model
    const policy = selected.legacyPrefix ? undefined : await registerCpaGroupPolicy({ keyId: key.id,
      allowedAuthIDs: selected.allowedAuthIDs, allowedPluginIDs: selected.allowedPluginIDs })
    const usageObserver = new BillingUsageObserver()
    const startedAt = Date.now()
    const presetIds = presets.map(preset => preset.id)
    const sessionId = typeof body.session_id === 'string' ? body.session_id : null
    try {
      await forwardNativeCpa(event, '/v1/' + path + requested.search, body, clientKey, policy, usageObserver)
      const statusCode = event.node.res.statusCode || 500
      const usage = usageObserver.value()
      const usageWithMetadata = usage ? {
        ...usage,
        nexus: { moduleId: 'cpa', groupIds: [...groupIds], presetIds },
      } : null
      await insertRequestLog({
        keyId: key.id, accountId: null, moduleId: 'cpa', sourceId: null,
        model: typeof body.model === 'string' ? body.model : model, protocol: path as 'chat/completions' | 'messages' | 'responses', sessionId,
        status: statusCode >= 400 ? 'error' : 'success', httpStatus: statusCode, durationMs: Date.now() - startedAt,
        streaming: String(event.node.res.getHeader('content-type') || '').includes('text/event-stream'), usage: usageWithMetadata,
        errorMessage: statusCode >= 400 ? `CPA core returned HTTP ${statusCode}` : null,
        requestBody: body, responseBody: null, responseTruncated: false,
      }).catch(error => console.error('[cpa] Request log could not be persisted', error instanceof Error ? error.message : 'Storage unavailable'))
      return
    } catch (error) {
      const partialUsage = usageObserver.value()
      await insertRequestLog({
        keyId: key.id, accountId: null, moduleId: 'cpa', sourceId: null,
        model: typeof body.model === 'string' ? body.model : model, protocol: path as 'chat/completions' | 'messages' | 'responses', sessionId,
        status: 'error', httpStatus: Number((error as { statusCode?: number }).statusCode) || event.node.res.statusCode || null,
        durationMs: Date.now() - startedAt, streaming: false,
        usage: partialUsage ? { ...partialUsage, nexus: { moduleId: 'cpa', groupIds: [...groupIds], presetIds } } : null,
        errorMessage: error instanceof Error ? error.message : 'CPA request failed', requestBody: body, responseBody: null, responseTruncated: false,
      }).catch(() => undefined)
      throw error
    }
  } catch (error) {
    if (event.node.res.headersSent) { event.node.res.destroy(); return }
    const status = Number((error as { statusCode?: number }).statusCode) || (/timeout/i.test(String(error)) ? 504 : 502)
    fail(event, path, status, status < 500 && error instanceof Error ? error.message : 'CPA request failed; check the core connection')
  }
}
