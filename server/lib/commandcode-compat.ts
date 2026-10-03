import type { H3Event } from 'h3'
import { getRequestURL } from 'h3'
import { authenticateGatewayKey } from './auth'
import { getSettings } from './settings'
import { requireModule } from './modules'
import { CPA_DEFAULT_URL, validateCpaBaseUrl } from './cpa/client'
import { handleGateway } from './gateway/handler'
import { listGatewayModels } from './gateway/accounts'
import { gatewayCors } from './gateway/cors'
import { makeProviderHeaders, readJsonBodyLimited, writeWithBackpressure } from './gateway/transport'
import { ORIGINAL_KEY_ID_HEADER, ORIGINAL_KEY_SIGNATURE_HEADER, signOriginalGatewayKey } from './commandcode-identity'

const PROTOCOLS = ['chat/completions', 'messages', 'responses']
const IDLE_MS = 120_000
function error(event: H3Event, protocol: string, status: number, code: string, message: string) {
  const response = event.node.res
  if (response.destroyed || response.writableEnded) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(protocol === 'messages' ? { type: 'error', error: { type: code, message } } : { error: { type: code, code, message } }))
}

/** Legacy manager keys enter CPA for protocol conversion; CPA returns to /v1 for native account execution. */
export async function handleCommandcodeCompatibility(event: H3Event) {
  await requireModule('commandcode')
  const pathname = getRequestURL(event).pathname
  const path = pathname.replace(/^\/commandcode\/v1\//, '').replace(/\/$/, '')
  const method = event.node.req.method || 'GET'
  const cors = gatewayCors('/v1/' + path, method, event.node.req.headers['access-control-request-headers'])
  if (cors) {
    for (const [name, value] of Object.entries(cors.headers)) event.node.res.setHeader(name, value)
    if (cors.preflight) { event.node.res.statusCode = 204; event.node.res.end(); return }
  }
  if (path === 'systemone' && method === 'POST') return handleGateway(event, { protocolPath: 'systemone' })
  if (!(path === 'models' && method === 'GET') && !(PROTOCOLS.includes(path) && method === 'POST')) {
    error(event, path, 404, 'not_found', 'Supported routes: GET /commandcode/v1/models and POST /commandcode/v1/chat/completions, /messages, /responses, /systemone')
    return
  }
  const auth = event.node.req.headers.authorization
  const xKey = event.node.req.headers['x-api-key']
  const secret = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : typeof xKey === 'string' ? xKey.trim() : ''
  const key = secret ? await authenticateGatewayKey(secret) : null
  if (!key) { error(event, path, 401, 'authentication_error', 'A valid manager API key is required'); return }
  if (path === 'models') return listGatewayModels()
  let body: Record<string, unknown>
  try { body = await readJsonBodyLimited(event, (await getSettings()).maxRequestBodyMb * 1024 * 1024) }
  catch (failure) {
    const status = Number((failure as { statusCode?: number }).statusCode) || 400
    error(event, path, status, 'invalid_request_error', status === 413 ? 'Request body exceeds the configured limit' : 'Request body must be a JSON object')
    return
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model || model.length > 256) { error(event, path, 400, 'invalid_request_error', 'model must be a non-empty string of at most 256 characters'); return }
  body.model = model.startsWith('commandcode/') ? model : 'commandcode/' + model
  let destination: string
  const clientKey = process.env.CPA_CLIENT_KEY?.trim()
  try {
    if (!clientKey) throw new Error('Missing CPA client key')
    destination = new URL('/v1/' + path, validateCpaBaseUrl(process.env.CPA_URL || CPA_DEFAULT_URL)).toString()
  } catch { error(event, path, 503, 'cpa_unavailable', 'Configure CPA_URL and CPA_CLIENT_KEY before using the compatibility endpoint'); return }
  const headers = makeProviderHeaders(event.node.req.headers, clientKey)
  headers.set(ORIGINAL_KEY_ID_HEADER, key.id)
  headers.set(ORIGINAL_KEY_SIGNATURE_HEADER, signOriginalGatewayKey(key.id))
  const controller = new AbortController()
  const onClose = () => { if (!event.node.res.writableEnded) controller.abort(new Error('Client disconnected')) }
  event.node.res.once('close', onClose)
  if (event.node.res.destroyed) onClose()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const resetIdle = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('CPA upstream idle timeout')), IDLE_MS); timer.unref() }
  try {
    resetIdle()
    const upstream = await fetch(destination, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' })
    if (timer) clearTimeout(timer)
    if (!upstream.body) throw new Error('CPA response has no body')
    reader = upstream.body.getReader()
    event.node.res.statusCode = upstream.status
    event.node.res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8')
    event.node.res.setHeader('cache-control', 'no-store')
    event.node.res.setHeader('x-accel-buffering', 'no')
    for (const name of ['retry-after', 'x-request-id']) { const value = upstream.headers.get(name); if (value) event.node.res.setHeader(name, value) }
    while (true) {
      resetIdle()
      const next = await reader.read()
      if (timer) clearTimeout(timer)
      if (controller.signal.aborted) throw controller.signal.reason
      if (next.done) break
      await writeWithBackpressure(event.node.res, next.value, controller.signal)
    }
    event.node.res.end()
  } catch (failure) {
    if (!controller.signal.aborted) controller.abort(failure)
    if (!event.node.res.headersSent && !event.node.res.destroyed) error(event, path, /timeout/i.test(failure instanceof Error ? failure.message : '') ? 504 : 502, 'cpa_upstream_error', 'CPA request failed; check the core connection and registered CommandCode channels')
    else if (!event.node.res.writableEnded && !event.node.res.destroyed) event.node.res.destroy()
  } finally {
    event.node.res.off('close', onClose)
    if (timer) clearTimeout(timer)
    if (reader) { try { await reader.cancel() } catch { /* Already ended or cancelled. */ } }
  }
}
