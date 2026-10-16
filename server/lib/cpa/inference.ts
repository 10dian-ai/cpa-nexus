import { randomUUID } from 'node:crypto'
import { getRequestURL, type H3Event } from 'h3'
import { resolveGroupPresetStack } from '../presets'
import { authenticateGatewayKey } from '../auth'
import { applyPresetStack, resolvePresetGenerationType } from '../presets/engine'
import { getSettings } from '../settings'
import { readJsonBodyLimited } from '../http/transport'
import { requireModule, isModuleEnabled } from '../modules'
import { gatewayCors } from '../http/cors'
import { resolveKeyRouting, type KeyGroupStrategy } from '../groups'
import { registerCpaGroupPolicy, invalidateCpaGroupPolicy } from './group-policy'
import { listCpaGroupOffers, resolvePoolBridgePolicy, type CpaGroupOffer } from './group-routing'
import { getNexusCpaCapabilities } from './nexus-capabilities'
import { bridgeAlias, bridgeChannelName } from './module-bridges'
import { routeHeaders } from '../bridge/identity'
import { readBridgeTrace } from '../bridge/trace'
import { forwardCpa, openCpaUpstream, pipeCpaResponse, readUpstreamText, type CpaUpstream, type PipeResult } from './forward'
import { BILLING_USAGE_POLICY, BILLING_USAGE_POLICY_HEADER, BillingUsageObserver, normalizeBillingRequest } from '../billing'
import { insertRequestLog } from '../logs'
import { redactModelResponseBody } from '../diagnostic-response'
import { publicErrorBody } from '../public-errors'
import { redactSensitiveText } from '../../../shared/log-privacy'
import { modelErrorBody } from '../model-errors'
import { upstreamIdleTimeoutMs } from '../timeouts'
import { ResponseCapture } from '../http/response-capture'
import { compressRequestImages, type ImageCompressionStats } from '../media/image-compress'
import type { AuthenticatedModelKey } from '../../../shared/keys'
import type { SystemSettings } from '../../../shared/types'
import type { PoolModuleId } from '../../../shared/modules'
import { planCpaRoute, sequenceAttempts, type CpaRouteAttempt, type PoolRouteAttempt, type RouteAttempt } from '../routing/plan'
import { resolvePoolGroups } from '../routing/pool'
import { applyDevinParams, devinThinkingLevels, isDevinModel } from '../routing/devin-params'
import { errorMessageFrom, isFailoverResponse } from '../routing/failover'
import { geminiModelList, listKeyModels } from '../routing/catalog'

/**
 * Public model entry for unified `ccm_` keys and native CPA keys.
 *
 *   client ─► nginx ─► /nexus/cpa/{v1,v1beta}/… (here)
 *     native CPA key ──────────────► CPA, untouched
 *     ccm_ model key ─► key groups ─► attempts (group × source) ─► CPA / pool bridge
 *
 * A pool-module source (Logicc …) is reached through CPA's kernel-owned bridge
 * channel: the request goes to CPA as `<alias>/<model>`, CPA converts the
 * client's protocol to Chat Completions and calls the module back with signed
 * route headers naming the serving group. Each attempt uses that group's
 * SillyTavern presets; Devin parameter conversion applies only to CPA's native
 * Devin provider. Failed attempts move to the next source or group.
 */
type Protocol = 'chat/completions' | 'messages' | 'responses'
type JsonObject = Record<string, unknown>
const GENERATION: ReadonlySet<string> = new Set(['chat/completions', 'messages', 'responses'])
const PRESET_PROTOCOL = { 'chat/completions': 'chat', messages: 'messages', responses: 'responses' } as const
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

interface ParsedEndpoint { family: 'v1' | 'v1beta'; path: string; search: URLSearchParams }
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
    if (!secret) { fail(event, label, 401, 'A valid model API key is required'); return }
    // Native CPA keys keep their original protocol, path and authentication.
    if (!secret.startsWith('ccm_')) {
      await forwardCpa({ event, path: `/${family}/${path}${endpoint.search.size ? '?' + endpoint.search.toString() : ''}`, timeoutMs: upstreamIdleTimeoutMs(await getSettings()) })
      return
    }
    const key = await authenticateGatewayKey(secret)
    if (!key) { fail(event, label, 401, 'A valid model API key is required'); return }
    settings = await getSettings()
    const routing = await resolveKeyRouting(key.id)
    if (!routing.groupIds.length) { fail(event, label, 403, 'This API key has no enabled groups'); return }

    if (event.method === 'GET' && (path === 'models' || path.startsWith('models/'))) {
      const models = await listKeyModels(key, routing.groupIds)
      if (path === 'models') return sendJson(event, family === 'v1beta' ? geminiModelList(models) : { object: 'list', data: models })
      const id = decodeURIComponent(path.slice('models/'.length))
      const model = models.find(item => item.id === id)
      if (!model) { fail(event, label, 404, 'Model not found', 'model_not_found'); return }
      return sendJson(event, family === 'v1beta' ? geminiModelList([model]).models[0] : model)
    }

    const gemini = family === 'v1beta' ? /^models\/(.+):([A-Za-z]+)$/.exec(path) : null
    const contentType = String(event.node.req.headers['content-type'] || '')
    const jsonBody = event.method === 'POST' && (!contentType || /json/i.test(contentType)) && (gemini || family === 'v1')
    if (!jsonBody) return await forwardUnscoped(event, endpoint, key, routing.groupIds, settings)
    if (event.node.req.headers['content-encoding']) { fail(event, label, 415, 'Model API keys require an uncompressed JSON request'); return }
    const body = await readJsonBodyLimited(event, settings.maxRequestBodyMb * 1024 * 1024)
    const model = gemini ? decodeURIComponent(gemini[1]!) : typeof body.model === 'string' ? body.model.trim() : ''
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
    const explicit = Number((error as { statusCode?: number }).statusCode)
    const status = explicit || (/timeout/i.test(String(error)) ? 504 : 502)
    fail(event, label, status, explicit && error instanceof Error && error.message ? redactSensitiveText(error.message) : 'Service temporarily unavailable, please retry later',
      status === 422 ? 'preset_route_error' : undefined)
  }
}

interface ModelRequest {
  event: H3Event; endpoint: ParsedEndpoint; key: AuthenticatedModelKey; groupIds: string[]; strategy: KeyGroupStrategy
  settings: SystemSettings; body: JsonObject; model: string
  protocol?: Protocol
  logProtocol: string
  cpaPathFor: (nativeModel: string) => string
  images?: ImageCompressionStats & { maxEdge?: number; quality?: number; steps?: number }
  originalBody?: JsonObject
  requestId?: string
}
interface AttemptRecord { kind: 'cpa' | 'pool'; moduleId?: string; groupId: string; model?: string; status: number; error: string }

async function runModelRequest(request: ModelRequest) {
  const { event, key, groupIds, protocol, model } = request
  const label = request.logProtocol
  request.requestId = randomUUID()
  await requireModule('cpa')
  if (!process.env.CPA_CLIENT_KEY?.trim()) { fail(event, label, 503, 'Service temporarily unavailable, please retry later'); return }
  const plan = await planCpaRoute({ model, groupIds })
  // Pool modules apply only to generation requests from unrestricted keys.
  const poolGroups = protocol && key.moduleId === 'auto' ? await resolvePoolGroups(model, groupIds) : new Map<PoolModuleId, Map<string, string>>()
  const attempts = sequenceAttempts({ groupIds, strategy: request.strategy, rotationKey: key.id + '\0' + model, perGroup: plan.perGroup, poolGroups })
  if (!attempts.length) { fail(event, label, 404, 'The requested model is not available for this API key', 'model_not_found'); return }
  if (request.settings.imageMaxEdge > 0) {
    const compressed = await compressRequestImages(request.body, { maxEdge: request.settings.imageMaxEdge, quality: request.settings.imageQuality })
    if (compressed.stats.images) {
      request.originalBody = request.body
      request.images = { ...compressed.stats, maxEdge: request.settings.imageMaxEdge, quality: request.settings.imageQuality, steps: 0 }
    }
    request.body = compressed.body
  }
  const failures: AttemptRecord[] = []
  const startedAt = Date.now()
  for (const [index, attempt] of attempts.entries()) {
    const last = index === attempts.length - 1
    let outcome = await runAttempt(request, attempt, last, failures, startedAt)
    while (outcome === 'retry') outcome = await runAttempt(request, attempt, last, failures, startedAt)
    if (outcome === 'done') return
  }
  const lastFailure = failures.at(-1)
  const status = lastFailure?.status || 502
  fail(event, label, status, redactSensitiveText(lastFailure?.error || 'All sources for this model failed'))
  await logRequest(request, { status, startedAt, failures, error: lastFailure?.error || 'All sources failed', body: request.body })
}

const SHRINK_STEPS = [{ maxEdge: 1536, quality: 80 }, { maxEdge: 1024, quality: 75 }, { maxEdge: 768, quality: 70 }]
async function shrinkAfterTooLarge(request: ModelRequest): Promise<boolean> {
  if (!request.originalBody || !request.images) return false
  for (let step = request.images.steps ?? 0; step < SHRINK_STEPS.length; step++) {
    const settings = SHRINK_STEPS[step]!
    if (request.images.maxEdge && settings.maxEdge >= request.images.maxEdge && settings.quality >= (request.images.quality ?? 100)) continue
    const result = await compressRequestImages(request.originalBody, { ...settings, minBytes: 0 })
    if (!result.stats.compressed || result.stats.afterBytes >= request.images.afterBytes) continue
    request.body = result.body
    request.images = { ...result.stats, ...settings, steps: step + 1 }
    return true
  }
  return false
}

/** Build the request body for one attempt: the serving group's presets, then billing usage opt-in. */
async function attemptBody(request: ModelRequest, groupId: string): Promise<{ body: JsonObject; presetIds: string[] }> {
  let body: JsonObject = { ...request.body }
  let presetIds: string[] = []
  if (request.protocol) {
    const presets = await resolveGroupPresetStack(groupId)
    if (presets.length) {
      body = applyPresetStack(presets, body, { protocol: PRESET_PROTOCOL[request.protocol], generationType: resolvePresetGenerationType(body, request.event.node.req.headers) })
      presetIds = presets.map(preset => preset.id)
    }
    if (Object.hasOwn(body, 'generation_type')) delete body.generation_type
    body = normalizeBillingRequest(body, request.protocol)
  }
  return { body, presetIds }
}

type AttemptOutcome = 'done' | 'next' | 'retry'
function runAttempt(request: ModelRequest, attempt: RouteAttempt, last: boolean, failures: AttemptRecord[], startedAt: number): Promise<AttemptOutcome> {
  return attempt.kind === 'pool'
    ? runPoolAttempt(request, attempt, last, failures, startedAt)
    : runCpaAttempt(request, attempt, last, failures, startedAt)
}

/** A pool-module source, reached through its CPA bridge channel. */
async function runPoolAttempt(request: ModelRequest, attempt: PoolRouteAttempt, last: boolean, failures: AttemptRecord[], startedAt: number): Promise<AttemptOutcome> {
  const { event, key, settings } = request
  const channelName = bridgeChannelName(attempt.moduleId)
  const { body, presetIds } = await attemptBody(request, attempt.groupId)
  const aliasModel = `${bridgeAlias(attempt.moduleId)}/${attempt.nativeModel}`
  if (request.endpoint.family === 'v1') body.model = aliasModel
  const record = (status: number, error: string) => failures.push({ kind: 'pool', moduleId: attempt.moduleId, groupId: attempt.groupId, model: aliasModel, status, error })
  const timeoutMs = upstreamIdleTimeoutMs(settings)
  let policy: string
  let extraHeaders: Record<string, string>
  try {
    policy = await registerCpaGroupPolicy({ keyId: key.id, ...await resolvePoolBridgePolicy(channelName) })
    extraHeaders = routeHeaders({ moduleId: attempt.moduleId, keyId: key.id, groupId: attempt.groupId, requestId: request.requestId! })
  } catch (error) {
    if (last) throw error
    record(Number((error as { statusCode?: number }).statusCode) || 503, error instanceof Error ? error.message : '模块桥接策略不可用')
    return 'next'
  }
  let upstream: CpaUpstream
  try {
    upstream = await openCpaUpstream({ event, path: request.cpaPathFor(aliasModel), method: 'POST', body, clientKey: process.env.CPA_CLIENT_KEY!.trim(), policy, extraHeaders, timeoutMs })
  } catch (error) {
    if (last) throw error
    record(/timeout/i.test(String(error)) ? 504 : 502, error instanceof Error ? error.message : 'CPA connection failed')
    return 'next'
  }
  const status = upstream.response.statusCode || 502
  if (status >= 400 && (!last || status === 413)) {
    const text = await readUpstreamText(upstream.response)
    if (status === 413 && await shrinkAfterTooLarge(request)) { record(status, '请求体过大，缩小图片后重试'); return 'retry' }
    // The module tells us to hand the request to another source.
    if (!last && isFailoverResponse(status, text)) { record(status, errorMessageFrom(text)); return 'next' }
    event.node.res.statusCode = status
    event.node.res.setHeader('content-type', String(upstream.response.headers['content-type'] || 'application/json; charset=utf-8'))
    const shown = new TextDecoder().decode(redactModelResponseBody(Buffer.from(text.split(aliasModel).join(attempt.nativeModel)), status))
    event.node.res.end(publicErrorBody(shown, status))
    await logRequest(request, { status, startedAt, failures, body, poolAttempt: attempt, presetIds, error: errorMessageFrom(text), responseBody: parseLogBody(text) })
    return 'done'
  }
  if (presetIds.length) event.node.res.setHeader('x-nexus-preset-id', presetIds.join(','))
  if (request.protocol) event.node.res.setHeader(BILLING_USAGE_POLICY_HEADER, BILLING_USAGE_POLICY)
  const usageObserver = new BillingUsageObserver()
  const capture = new ResponseCapture()
  let piped: PipeResult | undefined
  try {
    // Callers see the model name they know, never the bridge alias.
    piped = await pipeCpaResponse(event, upstream, { usageObserver, capture, timeoutMs, rewrite: [[aliasModel, attempt.nativeModel]] })
  } finally {
    await logRequest(request, {
      status: piped?.status ?? status, startedAt, failures, body, poolAttempt: attempt, presetIds, piped, usage: usageObserver.value(),
      error: piped ? piped.outcome.errorMessage : '模块响应中断',
      responseBody: capture.value(piped?.streaming ?? false), responseTruncated: capture.truncated,
    })
  }
  return 'done'
}

async function runCpaAttempt(request: ModelRequest, attempt: CpaRouteAttempt, last: boolean, failures: AttemptRecord[], startedAt: number): Promise<AttemptOutcome> {
  const { event, key, settings } = request
  const { body: presetBody, presetIds } = await attemptBody(request, attempt.groupId)
  let body = presetBody
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
      if (errorText.includes('nexus_group_policy_invalid')) { invalidateCpaGroupPolicy(policyInput); errorText = undefined; continue }
    }
    break
  }
  const status = upstream.response.statusCode || 502
  if (status >= 400 && (!last || errorText !== undefined || status === 413)) {
    const text = errorText ?? await readUpstreamText(upstream.response)
    if (status === 413 && await shrinkAfterTooLarge(request)) { record(status, `请求体过大，缩小图片后重试（最长边 ${request.images!.maxEdge}px）`); return 'retry' }
    if (!last && isFailoverResponse(status, text)) { record(status, errorMessageFrom(text)); return 'next' }
    if (status === 413) {
      const message = tooLargeMessage(body, request.images)
      fail(event, request.logProtocol, 413, message, 'request_too_large')
      await logRequest(request, { status, startedAt, failures, error: message, body, cpaAttempt: attempt, presetIds, devin, responseBody: parseLogBody(text) })
      return 'done'
    }
    const res = event.node.res
    res.statusCode = status
    res.setHeader('content-type', String(upstream.response.headers['content-type'] || 'application/json; charset=utf-8'))
    res.end(publicErrorBody(new TextDecoder().decode(redactModelResponseBody(Buffer.from(text), status)), status))
    await logRequest(request, { status, startedAt, failures, error: errorMessageFrom(text), body, cpaAttempt: attempt, presetIds, devin, responseBody: parseLogBody(text) })
    return 'done'
  }
  if (presetIds.length) event.node.res.setHeader('x-nexus-preset-id', presetIds.join(','))
  else event.node.res.removeHeader('x-nexus-preset-id')
  if (request.protocol) event.node.res.setHeader(BILLING_USAGE_POLICY_HEADER, BILLING_USAGE_POLICY)
  const usageObserver = new BillingUsageObserver()
  const capture = new ResponseCapture()
  let piped: PipeResult | undefined
  try {
    piped = await pipeCpaResponse(event, upstream, { usageObserver, capture, timeoutMs })
  } finally {
    await logRequest(request, {
      status: piped?.status ?? status, startedAt, failures, body, cpaAttempt: attempt, presetIds, devin, piped, usage: usageObserver.value(),
      error: piped ? piped.outcome.errorMessage : 'CPA response interrupted',
      responseBody: capture.value(piped?.streaming ?? false), responseTruncated: capture.truncated,
    })
  }
  return 'done'
}

function tooLargeMessage(body: JsonObject, images?: ModelRequest['images']): string {
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
  const size = mb(Buffer.byteLength(JSON.stringify(body)))
  const detail = images?.images
    ? images.compressed
      ? ` ${images.images} image(s) were compressed from ${mb(images.beforeBytes)} MB to ${mb(images.afterBytes)} MB (longest edge ${images.maxEdge}px).`
      : ` ${images.images} image(s) could not be compressed (for example HEIC) and were sent as they are.`
    : ''
  return `The request is too large (about ${size} MB).${detail} Reduce the number or size of images and retry.`
}

function parseLogBody(text: string): unknown {
  try { return JSON.parse(text) } catch { return text ? { format: 'text', raw: text, truncated: false } : null }
}

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
  cpaAttempt?: CpaRouteAttempt; poolAttempt?: PoolRouteAttempt; presetIds?: string[]; devin?: { level: string; source: string; removed: string[] }
  piped?: PipeResult; usage?: Record<string, unknown> | null; responseBody?: unknown; responseTruncated?: boolean
}) {
  try {
    const pool = input.poolAttempt
    const moduleId = pool ? pool.moduleId : 'cpa'
    let sourceId: string | null = null
    let usageSource: string | undefined
    let usageDetail: Record<string, unknown> | undefined
    if (pool) {
      const trace = await readBridgeTrace(request.requestId!).catch(() => null)
      sourceId = trace?.accountId || null
      usageSource = trace?.usageSource
      usageDetail = trace?.usageDetail
    } else {
      const offers = input.piped?.authIndex ? await listCpaGroupOffers(request.groupIds).catch(() => undefined) : undefined
      sourceId = await sourceForAuthIndex(input.piped?.authIndex ?? null, offers)
    }
    const status = input.piped ? input.piped.outcome.logStatus(input.piped.status) : 'error'
    await insertRequestLog({
      keyId: request.key.id, moduleId, sourceId,
      model: request.model, protocol: request.logProtocol,
      sessionId: typeof request.body.session_id === 'string' ? request.body.session_id : null,
      status, httpStatus: input.status, durationMs: Date.now() - input.startedAt, streaming: !!input.piped?.streaming,
      usage: {
        ...(input.usage || {}),
        nexus: {
          moduleId, groupIds: [...request.groupIds], strategy: request.strategy,
          ...(input.cpaAttempt ? { groupId: input.cpaAttempt.groupId, nativeModel: input.cpaAttempt.nativeModel } : {}),
          ...(pool ? { groupId: pool.groupId, nativeModel: pool.nativeModel, ...(usageSource ? { usageSource } : {}), ...(usageDetail ? { usageDetail } : {}) } : {}),
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

async function forwardUnscoped(event: H3Event, endpoint: ParsedEndpoint, key: AuthenticatedModelKey, groupIds: string[], settings: SystemSettings, body?: JsonObject) {
  await requireModule('cpa')
  const clientKey = process.env.CPA_CLIENT_KEY?.trim()
  if (!clientKey) { fail(event, endpoint.path, 503, 'Service temporarily unavailable, please retry later'); return }
  const offers = await listCpaGroupOffers(groupIds)
  if (!offers.length) { fail(event, endpoint.path, 404, 'No source is available for this API key', 'model_not_found'); return }
  const policy = await registerCpaGroupPolicy({ keyId: key.id, allowedAuthIDs: [...new Set(offers.flatMap(offer => offer.authIds))],
    allowedPluginIDs: [...new Set(offers.flatMap(offer => offer.pluginId ? [offer.pluginId] : []))] })
  await forwardCpa({ event, path: cpaPath(endpoint), body, clientKey, policy, timeoutMs: upstreamIdleTimeoutMs(settings) })
}
