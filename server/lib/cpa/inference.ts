import { getRequestURL, type H3Event } from 'h3'
import { handleCommandcodeCompatibility, isCommandcodeFailure } from '../commandcode-compat'
import { handleGateway } from '../gateway/handler'
import { verifyOriginalGatewayKey } from '../commandcode-identity'
import { resolveGroupPresetStack } from '../presets'
import { authenticateGatewayKey } from '../auth'
import { applyPresetStack, resolvePresetGenerationType } from '../presets/engine'
import { getSettings } from '../settings'
import { readJsonBodyLimited } from '../gateway/transport'
import { isModuleEnabled, requireModule } from '../modules'
import { gatewayCors } from '../gateway/cors'
import { accountGroupBindings, resolveKeyRouting, type KeyGroupStrategy } from '../groups'
import { listCandidates } from '../gateway/accounts'
import { getProviderModel } from '../official-catalog'
import { invalidateCpaGroupPolicy, registerCpaGroupPolicy } from './group-policy'
import { listCpaGroupOffers, type CpaGroupOffer } from './group-routing'
import { getNexusCpaCapabilities } from './nexus-capabilities'
import { forwardCpa, openCpaUpstream, pipeCpaResponse, readUpstreamText, type CpaUpstream, type PipeResult } from './forward'
import { BILLING_USAGE_POLICY, BILLING_USAGE_POLICY_HEADER, BillingUsageObserver, normalizeBillingRequest } from '../billing'
import { insertRequestLog } from '../logs'
import { redactModelResponseBody } from '../diagnostic-response'
import { redactSensitiveText } from '../../../shared/log-privacy'
import { modelErrorBody } from '../model-errors'
import { upstreamIdleTimeoutMs } from '../timeouts'
import { ResponseCapture } from '../gateway/response'
import { compressRequestImages, type ImageCompressionStats } from '../media/image-compress'
import type { AuthenticatedModelKey } from '../../../shared/keys'
import type { SystemSettings } from '../../../shared/types'
import { planCpaRoute, sequenceAttempts, type CpaRouteAttempt, type RouteAttempt } from '../routing/plan'
import { applyDevinParams, devinThinkingLevels, isDevinModel } from '../routing/devin-params'
import { errorMessageFrom, isFailoverResponse } from '../routing/failover'
import { geminiModelList, listKeyModels } from '../routing/catalog'

/**
 * Public model entry for unified `ccm_` keys and native CPA keys.
 *
 *   client ─► nginx ─► /nexus/cpa/{v1,v1beta}/… (here)
 *     native CPA key ──────────────► CPA, untouched
 *     ccm_ model key ─► key groups ─► attempts (group × source) ─► CPA / CommandCode
 *
 * Each attempt uses the presets of the group it runs in, Devin parameter
 * conversion when the source is CPA's Devin provider, and a short-lived CPA
 * group policy so the kernel only selects credentials of that group. Failed
 * attempts (credentials, access, rate limit, upstream errors) move on to the
 * next source or group before anything reaches the client.
 */
type Protocol = 'chat/completions' | 'messages' | 'responses'
type JsonObject = Record<string, unknown>
const GENERATION: ReadonlySet<string> = new Set(['chat/completions', 'messages', 'responses'])
const PRESET_PROTOCOL = { 'chat/completions': 'chat', messages: 'messages', responses: 'responses' } as const
/** Bridge callbacks from CPA into the CommandCode gateway. */
const BRIDGE_PATHS = new Set(['chat/completions', 'messages', 'responses', 'systemone'])
// Kept for callers upgrading from the former native-key authentication cache.
export function resetCpaInferenceAuthCache() {}

function fail(event: H3Event, protocol: string, status: number, message: string, code?: string) {
  if (event.node.res.destroyed || event.node.res.writableEnded) return
  event.node.res.statusCode = status
  event.node.res.setHeader('content-type', 'application/json; charset=utf-8')
  event.node.res.end(JSON.stringify(modelErrorBody(protocol, status, message, code)))
}
function sendJson(event: H3Event, value: unknown) {
  event.node.res.statusCode = 200
  event.node.res.setHeader('content-type', 'application/json; charset=utf-8')
  event.node.res.end(JSON.stringify(value))
}

interface ParsedEndpoint {
  family: 'v1' | 'v1beta'
  /** Path below the family, e.g. `chat/completions` or `models/gemini-pro:generateContent`. */
  path: string
  search: URLSearchParams
}
function parseEndpoint(event: H3Event): ParsedEndpoint {
  const url = getRequestURL(event)
  const match = /^(?:\/nexus\/cpa)?\/(v1beta|v1)(?:\/(.*))?$/.exec(url.pathname)
  return { family: (match?.[1] as 'v1' | 'v1beta') || 'v1', path: (match?.[2] || '').replace(/\/$/, ''), search: url.searchParams }
}

function readSecret(event: H3Event, search: URLSearchParams): string {
  const authorization = event.node.req.headers.authorization
  if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim()
  for (const name of ['x-api-key', 'x-goog-api-key']) {
    const value = event.node.req.headers[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return search.get('key')?.trim() || ''
}

/** CPA path for a request, without the caller's own `key=` query credential. */
function cpaPath(endpoint: ParsedEndpoint, path = endpoint.path) {
  const search = new URLSearchParams(endpoint.search)
  search.delete('key')
  const query = search.toString()
  return `/${endpoint.family}/${path}${query ? '?' + query : ''}`
}

export async function handleNexusInference(event: H3Event) {
  const endpoint = parseEndpoint(event)
  const { family, path } = endpoint
  const label = family === 'v1beta' ? 'gemini' : path
  const cors = gatewayCors('/v1/' + path, event.method, event.node.req.headers['access-control-request-headers'])
  if (cors) {
    for (const [name, value] of Object.entries(cors.headers)) event.node.res.setHeader(name, value)
    if (cors.preflight) { event.node.res.statusCode = 204; event.node.res.end(); return }
  }
  const secret = readSecret(event, endpoint.search)
  let settings: SystemSettings | undefined
  try {
    // Native CPA keys may use any non-empty value, but an absent credential
    // must be rejected here instead of becoming a misleading upstream 502.
    if (!secret) { fail(event, label, 401, 'A valid model API key is required'); return }
    // Existing native core keys keep their original protocol, path and authentication.
    if (!secret.startsWith('ccm_')) {
      await forwardCpa({ event, path: `/${family}/${path}${endpoint.search.size ? '?' + endpoint.search.toString() : ''}`, timeoutMs: upstreamIdleTimeoutMs(await getSettings()) })
      return
    }
    // A signed CommandCode bridge callback from CPA keeps the original key, groups and presets.
    if (family === 'v1' && secret.startsWith('ccm_nexus_') && BRIDGE_PATHS.has(path) && verifyOriginalGatewayKey(event.node.req.headers)) {
      return await handleGateway(event, { protocolPath: path as Protocol | 'systemone' })
    }
    const key = await authenticateGatewayKey(secret)
    if (!key || secret.startsWith('ccm_nexus_')) { fail(event, label, 401, 'A valid model API key is required'); return }
    settings = await getSettings()
    const moduleId = key.moduleId || 'commandcode'
    if (moduleId === 'commandcode') {
      if (family === 'v1' && ((path === 'models' && event.method === 'GET') || ((GENERATION.has(path) || path === 'systemone') && event.method === 'POST'))) {
        return await handleCommandcodeCompatibility(event, { protocolPath: path })
      }
      fail(event, label, 404, 'This endpoint is only available for CPA sources', 'unsupported_endpoint'); return
    }
    const routing = await resolveKeyRouting(key.id)
    if (!routing.groupIds.length) { fail(event, label, 403, '这个模型 API Key 没有已启用的分组'); return }

    if (event.method === 'GET' && (path === 'models' || path.startsWith('models/'))) {
      const models = await listKeyModels(key, routing.groupIds)
      if (path === 'models') return sendJson(event, family === 'v1beta' ? geminiModelList(models) : { object: 'list', data: models })
      const id = decodeURIComponent(path.slice('models/'.length))
      const model = models.find(item => item.id === id)
      if (!model) { fail(event, label, 404, 'Model not found', 'model_not_found'); return }
      return sendJson(event, family === 'v1beta' ? geminiModelList([model]).models[0] : model)
    }
    if (family === 'v1' && path === 'systemone' && event.method === 'POST') {
      if (moduleId === 'auto') return await handleCommandcodeCompatibility(event, { protocolPath: path })
      fail(event, path, 403, 'System One requires a key with Command Code group access'); return
    }

    // Gemini: the model is part of the path, `models/<model>:<action>`.
    const gemini = family === 'v1beta' ? /^models\/(.+):([A-Za-z]+)$/.exec(path) : null
    const contentType = String(event.node.req.headers['content-type'] || '')
    const jsonBody = event.method === 'POST' && (!contentType || /json/i.test(contentType)) && (gemini || family === 'v1')
    if (!jsonBody) return await forwardUnscoped(event, endpoint, key, routing.groupIds, settings)
    if (event.node.req.headers['content-encoding']) { fail(event, label, 415, 'Model API keys require an uncompressed JSON request'); return }
    const body = await readJsonBodyLimited(event, settings.maxRequestBodyMb * 1024 * 1024)
    const model = gemini ? decodeURIComponent(gemini[1]!) : typeof body.model === 'string' ? body.model.trim() : ''
    // JSON calls that name no model (job control such as `responses/{id}/cancel`)
    // are left to CPA within the key's own sources.
    if (!gemini && body.model === undefined && !GENERATION.has(path)) return await forwardUnscoped(event, endpoint, key, routing.groupIds, settings, body)
    if (!model || model.length > 256) { fail(event, label, 400, 'model must be a non-empty string of at most 256 characters'); return }
    await runModelRequest({
      event, endpoint, key, groupIds: routing.groupIds, strategy: routing.strategy, settings, body, model,
      protocol: family === 'v1' && GENERATION.has(path) ? path as Protocol : undefined,
      logProtocol: gemini ? `v1beta/${gemini[2]}` : path,
      cpaPathFor: nativeModel => gemini ? cpaPath(endpoint, `models/${nativeModel}:${gemini[2]}`) : cpaPath(endpoint),
    })
  } catch (error) {
    if (event.node.res.headersSent) { event.node.res.destroy(); return }
    // Platform errors carry an explicit status and an actionable, redacted
    // message. Only bare transport failures fall back to the generic message.
    const explicit = Number((error as { statusCode?: number }).statusCode)
    const status = explicit || (/timeout/i.test(String(error)) ? 504 : 502)
    fail(event, label, status, explicit && error instanceof Error && error.message ? redactSensitiveText(error.message) : 'CPA request failed; check the core connection',
      status === 422 ? 'preset_route_error' : undefined)
  }
}

interface ModelRequest {
  event: H3Event; endpoint: ParsedEndpoint; key: AuthenticatedModelKey; groupIds: string[]; strategy: KeyGroupStrategy
  settings: SystemSettings; body: JsonObject; model: string
  /** Set for generation endpoints: presets, billing and CommandCode apply. */
  protocol?: Protocol
  logProtocol: string
  cpaPathFor: (nativeModel: string) => string
  /** Inline image resizing applied before routing, for logs. */
  images?: ImageCompressionStats
}
interface AttemptRecord { kind: 'cpa' | 'commandcode'; groupId: string; model?: string; status: number; error: string }

/** Groups (among the key's) holding a CommandCode account that can serve the model. */
async function commandcodeGroups(model: string, key: AuthenticatedModelKey, groupIds: string[]): Promise<Set<string> | undefined> {
  if (key.moduleId !== 'auto' || !await isModuleEnabled('commandcode')) return undefined
  let provider: Awaited<ReturnType<typeof getProviderModel>> = null
  try { provider = await getProviderModel(model) } catch { /* CPA can remain usable during a catalog outage. */ }
  if (!provider) return undefined
  const candidates = await listCandidates(model, key.id)
  if (!candidates.length) return undefined
  const bindings = await accountGroupBindings('commandcode', candidates.map(candidate => candidate.id))
  const groups = new Set([...bindings.values()].flatMap(binding => binding.groupIds))
  return new Set(groupIds.filter(id => groups.has(id)))
}

async function runModelRequest(request: ModelRequest) {
  const { event, key, groupIds, protocol, model } = request
  const label = request.logProtocol
  let attempts: RouteAttempt[]
  if (model.startsWith('commandcode/')) {
    if (key.moduleId !== 'auto') { fail(event, label, 403, 'This API key is bound to CPA and cannot call Command Code models'); return }
    if (!protocol) { fail(event, label, 404, 'This endpoint is only available for CPA sources', 'unsupported_endpoint'); return }
    attempts = [{ kind: 'commandcode', groupId: groupIds[0]! }]
  } else {
    await requireModule('cpa')
    if (!process.env.CPA_CLIENT_KEY?.trim()) { fail(event, label, 503, 'Configure CPA_CLIENT_KEY before using a unified CPA model key'); return }
    const plan = await planCpaRoute({ model, groupIds })
    const ccGroups = protocol ? await commandcodeGroups(model, key, groupIds) : undefined
    attempts = sequenceAttempts({ groupIds, strategy: request.strategy, rotationKey: key.id + '\0' + model, perGroup: plan.perGroup, commandcodeGroups: ccGroups })
    if (!attempts.length) { fail(event, label, 404, '当前 Key 的分组中没有可调用的这个模型', 'model_not_found'); return }
  }
  // Shrink large inline images once, before any attempt, so every source
  // (and every proxy on the way) receives the smaller request.
  if (request.settings.imageMaxEdge > 0) {
    const compressed = await compressRequestImages(request.body, { maxEdge: request.settings.imageMaxEdge, quality: request.settings.imageQuality })
    request.body = compressed.body
    if (compressed.stats.images) request.images = compressed.stats
  }
  const failures: AttemptRecord[] = []
  const startedAt = Date.now()
  for (const [index, attempt] of attempts.entries()) {
    const last = index === attempts.length - 1
    if (attempt.kind === 'commandcode') {
      const result = await handleCommandcodeCompatibility(event, { protocolPath: protocol!, body: { ...request.body }, failover: !last })
      if (isCommandcodeFailure(result)) { failures.push({ kind: 'commandcode', groupId: attempt.groupId, status: result.status, error: result.message }); continue }
      return
    }
    const outcome = await runCpaAttempt(request, attempt, last, failures, startedAt)
    if (outcome === 'done') return
  }
  // Every attempt failed over; report the last one.
  const lastFailure = failures.at(-1)
  const status = lastFailure?.status || 502
  fail(event, label, status, redactSensitiveText(lastFailure?.error || 'All sources for this model failed'))
  await logRequest(request, { status, startedAt, failures, error: lastFailure?.error || 'All sources failed', body: request.body })
}

async function runCpaAttempt(request: ModelRequest, attempt: CpaRouteAttempt, last: boolean, failures: AttemptRecord[], startedAt: number): Promise<'done' | 'next'> {
  const { event, key, protocol, settings } = request
  let body: JsonObject = { ...request.body }
  let presetIds: string[] = []
  if (protocol) {
    // The serving group decides the SillyTavern presets, never the key.
    const presets = await resolveGroupPresetStack(attempt.groupId)
    if (presets.length) {
      body = applyPresetStack(presets, body, { protocol: PRESET_PROTOCOL[protocol], generationType: resolvePresetGenerationType(body, event.node.req.headers) })
      presetIds = presets.map(preset => preset.id)
    }
    if (Object.hasOwn(body, 'generation_type')) delete body.generation_type
    body = normalizeBillingRequest(body, protocol)
  }
  let nativeModel = attempt.opaque ? attempt.nativeModel : attempt.nativeModel + (attempt.parenSuffix !== undefined ? `(${attempt.parenSuffix})` : '')
  let devin: { level: string; source: string; removed: string[] } | undefined
  if (!attempt.opaque && isDevinModel(attempt.nativeModel)) {
    const levels = (await devinThinkingLevels().catch(() => new Map<string, string[]>())).get(attempt.nativeModel.toLowerCase())
    const parenLevel = attempt.parenSuffix ? attempt.parenSuffix.trim().toLowerCase() : undefined
    const converted = applyDevinParams({
      body, nativeModel: attempt.nativeModel, supportedLevels: levels,
      nameLevel: (attempt.nameLevel || (parenLevel && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(parenLevel) ? parenLevel : undefined)) as never,
      options: { defaultLevel: settings.devinDefaultEffort || 'high', stripSampling: settings.devinStripSampling !== false },
    })
    body = converted.body
    nativeModel = converted.model
    devin = { level: converted.level, source: converted.levelSource, removed: converted.removed }
  }
  if (request.endpoint.family === 'v1') body.model = nativeModel
  const policyInput = { keyId: key.id, allowedAuthIDs: attempt.allowedAuthIDs, allowedPluginIDs: attempt.allowedPluginIDs }
  const timeoutMs = upstreamIdleTimeoutMs(settings)
  const record = (status: number, error: string) => failures.push({ kind: 'cpa', groupId: attempt.groupId, model: nativeModel, status, error })
  let upstream: CpaUpstream
  let errorText: string | undefined
  for (let round = 0; ; round++) {
    const policy = await registerCpaGroupPolicy(policyInput)
    try {
      upstream = await openCpaUpstream({ event, path: request.cpaPathFor(nativeModel), method: 'POST', body, clientKey: process.env.CPA_CLIENT_KEY!.trim(), policy, timeoutMs })
    } catch (error) {
      if (last) throw error
      record(/timeout/i.test(String(error)) ? 504 : 502, error instanceof Error ? error.message : 'CPA connection failed')
      return 'next'
    }
    if (upstream.response.statusCode === 403 && round === 0) {
      errorText = await readUpstreamText(upstream.response)
      // A cached policy CPA no longer holds (core restarted): register a new one once.
      if (errorText.includes('nexus_group_policy_invalid')) { invalidateCpaGroupPolicy(policyInput); errorText = undefined; continue }
    }
    break
  }
  const status = upstream.response.statusCode || 502
  if (status >= 400 && (!last || errorText !== undefined || status === 413)) {
    const text = errorText ?? await readUpstreamText(upstream.response)
    if (!last && isFailoverResponse(status, text)) { record(status, errorMessageFrom(text)); return 'next' }
    if (status === 413) {
      // Usually an nginx in front of the provider: explain instead of relaying its HTML page.
      const message = tooLargeMessage(body)
      fail(event, request.logProtocol, 413, message, 'request_too_large')
      await logRequest(request, { status, startedAt, failures, error: message, body, attempt, presetIds, devin, responseBody: parseLogBody(text) })
      return 'done'
    }
    // A client error that another source would reject as well, or the last failure: return it as is.
    const res = event.node.res
    res.statusCode = status
    res.setHeader('content-type', String(upstream.response.headers['content-type'] || 'application/json; charset=utf-8'))
    res.end(Buffer.from(redactModelResponseBody(Buffer.from(text), status)))
    await logRequest(request, { status, startedAt, failures, error: errorMessageFrom(text), body, attempt, presetIds, devin, responseBody: parseLogBody(text) })
    return 'done'
  }
  if (presetIds.length) event.node.res.setHeader('x-nexus-preset-id', presetIds.join(','))
  else event.node.res.removeHeader('x-nexus-preset-id')
  if (protocol) event.node.res.setHeader(BILLING_USAGE_POLICY_HEADER, BILLING_USAGE_POLICY)
  const usageObserver = new BillingUsageObserver()
  const capture = new ResponseCapture()
  let piped: PipeResult | undefined
  try {
    piped = await pipeCpaResponse(event, upstream, { usageObserver, capture, timeoutMs })
  } finally {
    await logRequest(request, {
      status: piped?.status ?? status, startedAt, failures, body, attempt, presetIds, devin, piped, usage: usageObserver.value(),
      error: piped ? piped.outcome.errorMessage : 'CPA response interrupted',
      responseBody: capture.value(piped?.streaming ?? false), responseTruncated: capture.truncated,
    })
  }
  return 'done'
}

function tooLargeMessage(body: JsonObject): string {
  const megabytes = (Buffer.byteLength(JSON.stringify(body)) / 1024 / 1024).toFixed(1)
  return `上游拒绝了过大的请求（约 ${megabytes} MB）：模型服务前面的代理限制了请求体大小。请减少或压缩图片，或让该上游调高请求体上限（nginx 的 client_max_body_size）。`
}

function parseLogBody(text: string): unknown {
  try { return JSON.parse(text) } catch { return text ? { format: 'text', raw: text, truncated: false } : null }
}

/** Map CPA's selected auth index back to the Nexus source that owns it. */
async function sourceForAuthIndex(authIndex: string | null, offers: CpaGroupOffer[] | undefined): Promise<string | null> {
  if (!authIndex) return null
  try {
    const account = (await getNexusCpaCapabilities())?.runtimeAccounts.find(item => item.authIndex === authIndex)
    if (!account) return null
    return (offers || []).find(offer => offer.authIds.includes(account.id))?.sourceId || account.fileName || account.id
  } catch { return null }
}

async function logRequest(request: ModelRequest, input: {
  status: number; startedAt: number; failures: AttemptRecord[]; body: JsonObject; error?: string | null
  attempt?: CpaRouteAttempt; presetIds?: string[]; devin?: { level: string; source: string; removed: string[] }
  piped?: PipeResult; usage?: Record<string, unknown> | null; responseBody?: unknown; responseTruncated?: boolean
}) {
  try {
    const offers = input.piped?.authIndex ? await listCpaGroupOffers(request.groupIds).catch(() => undefined) : undefined
    const sourceId = await sourceForAuthIndex(input.piped?.authIndex ?? null, offers)
    const status = input.piped ? input.piped.outcome.logStatus(input.piped.status) : 'error'
    await insertRequestLog({
      keyId: request.key.id, accountId: null, moduleId: 'cpa', sourceId,
      model: request.model, protocol: request.logProtocol,
      sessionId: typeof request.body.session_id === 'string' ? request.body.session_id : null,
      status, httpStatus: input.status, durationMs: Date.now() - input.startedAt, streaming: !!input.piped?.streaming,
      usage: {
        ...(input.usage || {}),
        nexus: {
          moduleId: 'cpa', groupIds: [...request.groupIds], strategy: request.strategy,
          ...(input.attempt ? { groupId: input.attempt.groupId, nativeModel: input.attempt.nativeModel } : {}),
          presetIds: input.presetIds || [],
          ...(input.devin ? { devin: input.devin } : {}),
          ...(input.piped?.authIndex ? { authIndex: input.piped.authIndex } : {}),
          ...(input.failures.length ? { failover: input.failures } : {}),
          ...(request.images ? { images: request.images } : {}),
        },
      },
      errorMessage: status === 'error' ? (input.error || `CPA core returned HTTP ${input.status}`) : status === 'incomplete' ? 'Stream ended without a completion event' : null,
      requestBody: input.body, responseBody: input.responseBody ?? null, responseTruncated: input.responseTruncated ?? false,
    })
  } catch (error) {
    console.error('[cpa] Request log could not be persisted', redactSensitiveText(error instanceof Error ? error.message : 'Storage unavailable'))
  }
}

/**
 * Requests without a JSON model field (multipart uploads, job polling): CPA
 * resolves the model; the policy still limits it to the key's own sources.
 */
async function forwardUnscoped(event: H3Event, endpoint: ParsedEndpoint, key: AuthenticatedModelKey, groupIds: string[], settings: SystemSettings, body?: JsonObject) {
  await requireModule('cpa')
  const clientKey = process.env.CPA_CLIENT_KEY?.trim()
  if (!clientKey) { fail(event, endpoint.path, 503, 'Configure CPA_CLIENT_KEY before using a unified CPA model key'); return }
  const offers = await listCpaGroupOffers(groupIds)
  if (!offers.length) { fail(event, endpoint.path, 404, '当前 Key 的分组中没有可调用的 CPA 来源', 'model_not_found'); return }
  const policy = await registerCpaGroupPolicy({ keyId: key.id, allowedAuthIDs: [...new Set(offers.flatMap(offer => offer.authIds))],
    allowedPluginIDs: [...new Set(offers.flatMap(offer => offer.pluginId ? [offer.pluginId] : []))] })
  await forwardCpa({ event, path: cpaPath(endpoint), body, clientKey, policy, timeoutMs: upstreamIdleTimeoutMs(settings) })
}
