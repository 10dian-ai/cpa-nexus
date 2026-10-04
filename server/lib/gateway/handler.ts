import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { getRequestURL } from 'h3'
import { authenticateGatewayKey, findEnabledModelKey, requireModelKeyModule } from '../auth'
import { getConfig } from '../config'
import { getProviderModel } from '../official-catalog'
import { PROVIDER_PROTOCOLS, requestCommandCodeProvider, type ProviderProtocol } from '../commandcode-provider'
import { decryptSecret } from '../crypto'
import { verifyOriginalGatewayKey } from '../commandcode-identity'
import { getRedis } from '../redis'
import { getSettings } from '../settings'
import { enqueueAccountRefresh } from '../queues'
import { insertRequestLog } from '../logs'
import { publishUpdate } from '../events'
import { extractAffinity } from './affinity'
import { gatewayCors } from './cors'
import { listCandidates, listGatewayModels, touchAccount, recordFailure, recordModelAllowed } from './accounts'
import { acquireLease, releaseLease, renewLease, RENEW_INTERVAL_MS, type Lease } from './scheduler'
import { classifyFailure, type UpstreamFailure } from './errors'
import { ResponseCapture, ResponseInspection, MAX_RESPONSE_LOG_BYTES } from './response'
import { readJsonBodyLimited, writeWithBackpressure } from './transport'
import { resolveKeyPresetStack } from '../presets'
import { applyPresetStack } from '../presets/engine'

type Protocol = ProviderProtocol
const PROTOCOLS: readonly Protocol[] = PROVIDER_PROTOCOLS
const MAX_ATTEMPTS = 2
const UPSTREAM_IDLE_MS = 120_000

function gatewayError(event: H3Event, protocol: string, status: number, code: string, message: string, retryAfter?: number, details?: Record<string, unknown>) {
  const res = event.node.res
  if (res.destroyed || res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  if (retryAfter !== undefined) res.setHeader('retry-after', String(retryAfter))
  const error = protocol === 'messages'
    ? { type: 'error', error: { type: code, message, ...details } }
    : { error: { type: code, code, message, ...details } }
  res.end(JSON.stringify(error))
}
function copyResponseHeaders(event: H3Event, upstream: Response) {
  const res = event.node.res
  res.statusCode = upstream.status
  res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-accel-buffering', 'no')
  const retryAfter = upstream.headers.get('retry-after')
  if (retryAfter) res.setHeader('retry-after', retryAfter)
}
function startRenewal(lease: Lease, controller: AbortController, onLost: () => void) {
  let busy = false
  let stopped = false
  const timer = setInterval(async () => {
    if (busy || stopped || controller.signal.aborted) return
    busy = true
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const renewed = await Promise.race([
        renewLease(getRedis(), lease),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Lease renewal timed out')), 5000) }),
      ])
      if (!renewed) throw new Error('Concurrency lease expired')
    } catch {
      if (!stopped) { onLost(); controller.abort(new Error('Concurrency lease could not be renewed')) }
    } finally {
      if (timeout) clearTimeout(timeout)
      busy = false
    }
  }, RENEW_INTERVAL_MS)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}

export async function handleGateway(event: H3Event, options?: { protocolPath?: ProviderProtocol }) {
  const pathname = getRequestURL(event).pathname
  const method = event.node.req.method || 'GET'
  const cors = gatewayCors(pathname, method, event.node.req.headers['access-control-request-headers'])
  if (cors) {
    for (const [name, value] of Object.entries(cors.headers)) event.node.res.setHeader(name, value)
    if (cors.preflight) {
      event.node.res.statusCode = 204
      event.node.res.end()
      return
    }
  }
  const path = options?.protocolPath || pathname.replace(/^\/v1\//, '').replace(/\/$/, '')
  if (!(path === 'models' && method === 'GET') && !(PROTOCOLS.includes(path as Protocol) && method === 'POST')) {
    gatewayError(event, path, 404, 'not_found', 'Supported routes: GET /v1/models and POST /v1/chat/completions, /v1/messages, /v1/responses, /v1/systemone')
    return
  }
  const auth = event.node.req.headers.authorization
  const bearer = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : null
  const xKey = event.node.req.headers['x-api-key']
  const secret = bearer || (typeof xKey === 'string' ? xKey : null)
  const key = secret ? await authenticateGatewayKey(secret) : null
  if (!key) {
    gatewayError(event, path, 401, 'authentication_error', 'A valid manager API key is required')
    return
  }
  const internalBridge = secret?.startsWith('ccm_nexus_') === true
  const originalKeyId = internalBridge ? verifyOriginalGatewayKey(event.node.req.headers) : null
  const presetKeyId = internalBridge ? originalKeyId : key.id
  const groupKeyId = originalKeyId || key.id
  try {
    const caller = originalKeyId ? await findEnabledModelKey(originalKeyId) : key
    if (!caller) { gatewayError(event, path, 403, 'permission_error', 'The original model API key is disabled or revoked'); return }
    await requireModelKeyModule(caller, 'commandcode')
  } catch (error) {
    const status = Number((error as { statusCode?: number }).statusCode) || 403
    gatewayError(event, path, status, 'permission_error', error instanceof Error ? error.message : 'This API key cannot call CommandCode')
    return
  }
  if (path === 'models') return listGatewayModels(groupKeyId)

  const protocol = path as Protocol
  const settings = await getSettings()
  let body: Record<string, unknown>
  try { body = await readJsonBodyLimited(event, settings.maxRequestBodyMb * 1024 * 1024) }
  catch (error) {
    const status = Number((error as { statusCode?: number }).statusCode) || 400
    gatewayError(event, protocol, status, 'invalid_request_error', status === 413 ? 'Request body exceeds the configured limit' : 'Request body must be a JSON object')
    return
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model || model.length > 256) {
    gatewayError(event, protocol, 400, 'invalid_request_error', 'model must be a non-empty string of at most 256 characters')
    return
  }
  body.model = model
  const streaming = body.stream === true
  let providerModel: Awaited<ReturnType<typeof getProviderModel>>
  try { providerModel = await getProviderModel(model) }
  catch {
    gatewayError(event, protocol, 503, 'model_catalog_unavailable', 'The official Provider model catalog is unavailable; refresh it before calling models', 5)
    return
  }
  if (!providerModel) {
    gatewayError(event, protocol, 400, 'unsupported_model', 'This model is not advertised by the official CommandCode Provider API', undefined, { model })
    return
  }
  if (!providerModel.supportedEndpoints.length) {
    gatewayError(event, protocol, 503, 'model_catalog_unavailable', 'Official supported endpoint metadata is unavailable for this model', 5, { model })
    return
  }
  if (!providerModel.supportedEndpoints.includes(protocol)) {
    const supportedEndpoints = providerModel.supportedEndpoints.map(endpoint => '/v1/' + endpoint)
    gatewayError(event, protocol, 400, 'invalid_request_error', 'This model does not support /v1/' + protocol + '; use ' + supportedEndpoints.join(', '), undefined, {
      model, supported_endpoints: supportedEndpoints,
    })
    return
  }
  if (protocol === 'systemone' && streaming) {
    gatewayError(event, protocol, 400, 'invalid_request_error', 'System One decision models do not support streaming')
    return
  }
  let logKeyId = key.id
  let affinityKeyId = key.id
  if (internalBridge) {
    if (originalKeyId) { affinityKeyId = originalKeyId; logKeyId = originalKeyId }
    else {
      const clientAuth = event.node.req.headers['x-nexus-client-authorization']
      const clientApiKey = event.node.req.headers['x-nexus-client-api-key']
      const identity = typeof clientAuth === 'string' ? clientAuth.replace(/^Bearer\s+/i, '').trim()
        : typeof clientApiKey === 'string' ? clientApiKey.trim() : ''
      if (identity && identity.length <= 4096) affinityKeyId += ':' + createHash('sha256').update(identity).digest('hex')
    }
  }
  const affinity = extractAffinity({ headers: event.node.req.headers, body, keyId: affinityKeyId })
  const requestId = randomUUID()
  event.node.res.setHeader('x-request-id', requestId)
  const controller = new AbortController()
  let disconnected = false
  let leaseLost = false
  const onClose = () => {
    if (!event.node.res.writableEnded) {
      disconnected = true
      controller.abort(new Error('Client disconnected'))
    }
  }
  event.node.res.once('close', onClose)
  if (event.node.res.destroyed) onClose()
  const startedAt = Date.now()
  const attempted = new Set<string>()
  let accountId: string | null = null
  let capture = new ResponseCapture()
  let inspection = new ResponseInspection()
  let completionForwarded = false
  let httpStatus: number | null = null
  let status: 'success' | 'error' | 'cancelled' | 'incomplete' = 'error'
  let errorMessage: string | null = null
  let upstreamFailure: UpstreamFailure | null = null
  let effectiveBody = body

  try {
    const allCandidates = await listCandidates(model, groupKeyId)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (controller.signal.aborted) throw controller.signal.reason
      const candidates = allCandidates.filter(candidate => !attempted.has(candidate.id))
      const result = await acquireLease(getRedis(), {
        candidates, globalLimit: settings.globalConcurrency,
        affinityHash: affinity.affinityHash, affinityTtlSeconds: settings.affinityTtlSeconds,
      })
      if (!result.ok) {
        httpStatus = result.reason === 'no_accounts' ? 503 : 429
        errorMessage = result.reason === 'no_accounts'
          ? 'No enabled account with usable credentials, quota and model access is currently available'
          : result.reason === 'global_capacity' ? 'Gateway global concurrency is full' : 'All eligible accounts are busy or temporarily cooling down'
        gatewayError(event, protocol, httpStatus, result.reason === 'no_accounts' ? 'no_available_accounts' : 'gateway_capacity', errorMessage, 5)
        return
      }
      const lease = result.lease
      accountId = lease.accountId
      attempted.add(accountId)
      const account = candidates.find(candidate => candidate.id === accountId)!
      const stopRenewal = startRenewal(lease, controller, () => { leaseLost = true })
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller.abort(new Error('Upstream idle timeout')), UPSTREAM_IDLE_MS)
        idleTimer.unref()
      }
      try {
        capture = new ResponseCapture()
        inspection = new ResponseInspection()
        completionForwarded = false
        upstreamFailure = null
        await touchAccount(accountId)
        const upstreamKey = decryptSecret(account.apiKeyCiphertext)
        effectiveBody = body
        if (protocol !== 'systemone') {
          const presets = presetKeyId ? await resolveKeyPresetStack(presetKeyId) : []
          if (presets.length) {
            effectiveBody = applyPresetStack(presets, body, { protocol: protocol === 'chat/completions' ? 'chat' : protocol })
            event.node.res.setHeader('x-nexus-preset-id', presets.map(preset => preset.id).join(','))
          } else event.node.res.removeHeader('x-nexus-preset-id')
        }
        resetIdle()
        // The owner requested GOAT's normal Provider API integration. Only
        // client-initiated inference reaches this endpoint, using the dedicated
        // account API key; browser cookies and client gateway keys are omitted.
        const upstream = await requestCommandCodeProvider({
          protocol, body: effectiveBody, apiKey: upstreamKey, headers: event.node.req.headers, signal: controller.signal,
        }, { baseUrl: getConfig().commandcodeApiUrl })
        if (idleTimer) clearTimeout(idleTimer)
        httpStatus = upstream.status
        if (!upstream.body) throw new Error('Upstream response has no body')
        reader = upstream.body.getReader()
        const pendingError: Uint8Array[] = []
        let pendingErrorBytes = 0
        let responseStarted = false
        while (true) {
          resetIdle()
          const next = await reader.read()
          if (idleTimer) clearTimeout(idleTimer)
          if (controller.signal.aborted) throw controller.signal.reason
          if (next.done) break
          capture.push(next.value)
          if (upstream.ok && streaming) inspection.push(next.value)
          if (!upstream.ok && !responseStarted && pendingErrorBytes + next.value.byteLength <= MAX_RESPONSE_LOG_BYTES) {
            pendingError.push(next.value)
            pendingErrorBytes += next.value.byteLength
            continue
          }
          if (!responseStarted) {
            copyResponseHeaders(event, upstream)
            responseStarted = true
            for (const chunk of pendingError) await writeWithBackpressure(event.node.res, chunk, controller.signal)
            pendingError.length = 0
          }
          await writeWithBackpressure(event.node.res, next.value, controller.signal)
          if (streaming && inspection.completed && !inspection.incomplete && !inspection.failure) completionForwarded = true
        }
        if (!upstream.ok) {
          upstreamFailure = classifyFailure(upstream.status, capture.truncated ? capture.text() : capture.value(false))
          // A stream is never replayed, and an ambiguous error is never retried.
          // A retry requires an explicit rejection and zero bytes sent downstream.
          await recordFailure(accountId, model, upstreamFailure).catch(error => console.error('[gateway] Model/error observation could not be saved', error instanceof Error ? error.message : 'Storage unavailable'))
          if (!streaming && !responseStarted && !capture.truncated && upstreamFailure.safeToRetry &&
              attempt + 1 < MAX_ATTEMPTS && candidates.some(candidate => candidate.id !== accountId)) continue
          if (!responseStarted) {
            copyResponseHeaders(event, upstream)
            for (const chunk of pendingError) await writeWithBackpressure(event.node.res, chunk, controller.signal)
          }
          errorMessage = upstreamFailure.message.replaceAll(upstreamKey, '[redacted]')
          status = 'error'
        } else {
          if (streaming) inspection.end()
          else if (!capture.truncated) {
            const payload = capture.value(false)
            inspection.observe(payload, upstream.status)
            // System One returns typed answers, rather than generated text or tools.
            if (protocol === 'systemone' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
              const answers = (payload as Record<string, unknown>).answers
              if (answers && typeof answers === 'object' && !Array.isArray(answers) && Object.keys(answers).length) {
                inspection.hasOutput = true
                inspection.completed = true
              }
            }
          }
          if (inspection.failure) {
            upstreamFailure = inspection.failure
            await recordFailure(accountId, model, upstreamFailure).catch(error => console.error('[gateway] Model/error observation could not be saved', error instanceof Error ? error.message : 'Storage unavailable'))
            errorMessage = upstreamFailure.message.replaceAll(upstreamKey, '[redacted]')
            status = 'error'
          } else if (inspection.incomplete || !inspection.hasOutput || (streaming && !inspection.completed)) {
            status = 'incomplete'
            errorMessage = inspection.incomplete ? 'Upstream reported an incomplete response'
              : capture.truncated && !streaming ? 'Response exceeded log limit; completion details could not be inspected'
              : !inspection.hasOutput ? 'No model output was observed' : 'Upstream stream ended without a completion event'
          } else {
            status = 'success'
          }
          if (inspection.hasOutput && !inspection.failure) await recordModelAllowed(accountId, model).catch(error => console.error('[gateway] Model access observation could not be saved', error instanceof Error ? error.message : 'Storage unavailable'))
          if (!responseStarted) copyResponseHeaders(event, upstream)
        }
        if (!event.node.res.writableEnded) event.node.res.end()
        break
      } finally {
        stopRenewal()
        if (idleTimer) clearTimeout(idleTimer)
        if (reader) {
          try { await reader.cancel() } catch { /* Request may have already ended. */ }
        }
        try { await releaseLease(getRedis(), lease) }
        catch (error) { console.error('[gateway] Lease release failed; its TTL will reclaim it', error instanceof Error ? error.message : 'Redis unavailable') }
        try { await enqueueAccountRefresh(account.id, { reason: 'request', force: false }) }
        catch (error) { console.error('[gateway] Account refresh could not be queued', error instanceof Error ? error.message : 'Queue unavailable') }
      }
    }
  } catch (error) {
    // CPA can finish its client stream at the terminal protocol frame, then close the
    // provider connection before its HTTP EOF. An already delivered completion is successful.
    const deliveredCompletion = disconnected && !leaseLost && streaming && completionForwarded
      && inspection.hasOutput && inspection.completed && !inspection.incomplete && !inspection.failure
    status = deliveredCompletion ? 'success' : disconnected && !leaseLost ? 'cancelled' : 'error'
    errorMessage = deliveredCompletion ? null : error instanceof Error ? error.message : 'Gateway request failed'
    if (leaseLost) errorMessage = 'Concurrency lease renewal failed; upstream request was cancelled'
    if (deliveredCompletion && accountId) await recordModelAllowed(accountId, model).catch(failure => console.error('[gateway] Model access observation could not be saved', failure instanceof Error ? failure.message : 'Storage unavailable'))
    if (!controller.signal.aborted) controller.abort(error)
    if (!event.node.res.headersSent && !disconnected) {
      const failureMessage = errorMessage || 'Gateway request failed'
      const validationStatus = Number((error as { statusCode?: number }).statusCode)
      httpStatus = validationStatus >= 400 && validationStatus < 500 ? validationStatus : /timeout/i.test(failureMessage) ? 504 : 502
      gatewayError(event, protocol, httpStatus, httpStatus < 500 ? 'preset_route_error' : 'gateway_upstream_error', failureMessage)
    } else if (!event.node.res.writableEnded && !event.node.res.destroyed) {
      event.node.res.destroy()
    }
  } finally {
    event.node.res.off('close', onClose)
    try {
      await insertRequestLog({
        id: requestId, keyId: logKeyId, accountId, model, protocol, sessionId: affinity.sessionId,
        status, httpStatus, durationMs: Date.now() - startedAt, streaming,
        usage: inspection.usage, errorMessage, requestBody: effectiveBody,
        responseBody: capture.value(streaming), responseTruncated: capture.truncated,
      })
      await publishUpdate({ type: 'request', ...(accountId ? { accountId } : {}) })
    } catch (error) {
      console.error('[gateway] Request log could not be persisted', error instanceof Error ? error.message : 'Storage unavailable')
    }
  }
}
