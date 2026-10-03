import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { getRequestURL, type H3Event } from 'h3'
import { CPA_DEFAULT_URL, validateCpaBaseUrl } from './client'
import { handleCommandcodeCompatibility } from '../commandcode-compat'
import { resolveKeyPresetRoute } from '../presets'
import { authenticateGatewayKey } from '../auth'
import { applyPreset } from '../presets/engine'
import { getSettings } from '../settings'
import { readJsonBodyLimited } from '../gateway/transport'
import { requireModule } from '../modules'
import { gatewayCors } from '../gateway/cors'

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
  const headers = copyHeaders(event.node.req.headers)
  if (clientKey) {
    for (const name of Object.keys(headers)) {
      if (name === 'cookie' || name === 'x-api-key' || name === 'x-goog-api-key' || name.startsWith('x-nexus-')) delete headers[name]
    }
    headers.authorization = 'Bearer ' + clientKey
  }
  return headers
}

/** Stream native requests and replies without changing their protocol or credentials. */
export async function forwardNativeCpa(event: H3Event, path: string, body?: Record<string, unknown>, clientKey?: string) {
  const url = destination(path)
  const headers = requestHeaders(event, clientKey)
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
      for (const [name, value] of Object.entries(copyHeaders(response.headers))) if (value !== undefined) event.node.res.setHeader(name, value)
      event.node.res.setHeader('x-accel-buffering', 'no')
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('CPA response interrupted')))
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

async function listCpaModels(event: H3Event, path: string, clientKey: string) {
  const headers = requestHeaders(event, clientKey)
  delete headers['content-length']
  const upstream = await fetch(destination(path), { headers: headers as HeadersInit, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  event.node.res.statusCode = upstream.status
  event.node.res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8')
  if (!upstream.ok) { event.node.res.end(await upstream.text()); return }
  const result = await upstream.json() as { data?: { id?: string }[]; [key: string]: unknown }
  if (!Array.isArray(result.data)) throw new Error('CPA returned an invalid model catalog')
  result.data = result.data.filter(model => typeof model.id === 'string' && !model.id.startsWith('commandcode/'))
  event.node.res.end(JSON.stringify(result))
}

/** A platform model key selects its provider; the internal CommandCode /v1 callback stays separate. */
export async function handleNexusInference(event: H3Event) {
  const requested = getRequestURL(event)
  const path = requested.pathname.replace(/^(?:\/nexus\/cpa)?\/v1\//, '').replace(/\/$/, '')
  const protocol = PROTOCOLS.get(path as 'chat/completions' | 'messages' | 'responses')
  const cors = gatewayCors('/v1/' + path, event.method, event.node.req.headers['access-control-request-headers'])
  if (cors) {
    for (const [name, value] of Object.entries(cors.headers)) event.node.res.setHeader(name, value)
    if (cors.preflight) { event.node.res.statusCode = 204; event.node.res.end(); return }
  }
  if (!((path === 'models' && event.method === 'GET') || ((protocol || path === 'systemone') && event.method === 'POST'))) { fail(event, path, 404, 'Unsupported model endpoint'); return }
  const authorization = event.node.req.headers.authorization
  const apiKey = event.node.req.headers['x-api-key']
  const secret = typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, '').trim() : typeof apiKey === 'string' ? apiKey.trim() : ''
  try {
    // Existing native core keys retain their original protocol and authentication.
    if (!secret.startsWith('ccm_')) return await forwardNativeCpa(event, '/v1/' + path + requested.search)
    const key = await authenticateGatewayKey(secret)
    if (!key || secret.startsWith('ccm_nexus_')) { fail(event, path, 401, 'A valid model API key is required'); return }
    const moduleId = key.moduleId || 'commandcode'
    if (moduleId === 'commandcode') return await handleCommandcodeCompatibility(event, { protocolPath: path })
    await requireModule('cpa')
    if (path === 'systemone') { fail(event, path, 403, 'System One requires a key bound to Command Code'); return }
    const clientKey = process.env.CPA_CLIENT_KEY?.trim()
    if (!clientKey) { fail(event, path, 503, 'Configure CPA_CLIENT_KEY before using a unified CPA model key'); return }
    if (path === 'models') return await listCpaModels(event, '/v1/models' + requested.search, clientKey)
    if (event.node.req.headers['content-encoding']) { fail(event, path, 415, 'Model API keys require an uncompressed JSON request'); return }
    let body = await readJsonBodyLimited(event, (await getSettings()).maxRequestBodyMb * 1024 * 1024)
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model || model.length > 256) { fail(event, path, 400, 'model must be a non-empty string of at most 256 characters'); return }
    if (model.startsWith('commandcode/')) { fail(event, path, 403, 'This key is bound to CPA; choose a key bound to Command Code for this model'); return }
    body.model = model
    const preset = await resolveKeyPresetRoute(key.id)
    if (preset) {
      body = applyPreset(preset, body, { protocol: protocol! })
      event.node.res.setHeader('x-nexus-preset-id', preset.id)
    }
    return await forwardNativeCpa(event, '/v1/' + path + requested.search, body, clientKey)
  } catch (error) {
    if (event.node.res.headersSent) { event.node.res.destroy(); return }
    const status = Number((error as { statusCode?: number }).statusCode) || (/timeout/i.test(String(error)) ? 504 : 502)
    fail(event, path, status, status < 500 && error instanceof Error ? error.message : 'CPA request failed; check the core connection')
  }
}
