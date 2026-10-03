import { createHash } from 'node:crypto'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { getRequestURL, type H3Event } from 'h3'
import { CPA_DEFAULT_URL, validateCpaBaseUrl } from './client'
import { handleCommandcodeCompatibility } from '../commandcode-compat'
import { resolvePresetRoute } from '../presets'
import { applyPreset } from '../presets/engine'
import { getSettings } from '../settings'
import { readJsonBodyLimited } from '../gateway/transport'
import { isModuleEnabled } from '../modules'
import { findCpaPresetAccountForModel } from './preset-routing'

const PROTOCOLS = new Map([['chat/completions', 'chat'], ['messages', 'messages'], ['responses', 'responses']] as const)
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const verifiedKeys = new Map<string, number>()
export function resetCpaInferenceAuthCache() { verifiedKeys.clear() }

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

/** CPA remains responsible for native authentication, using its actual model endpoint. */
async function verifyBeforePreset(event: H3Event): Promise<boolean> {
  const headers = copyHeaders(event.node.req.headers)
  const fingerprint = createHash('sha256').update(JSON.stringify([
    process.env.CPA_URL, headers.authorization, headers['x-api-key'], headers['x-goog-api-key'],
  ])).digest('hex')
  if ((verifiedKeys.get(fingerprint) || 0) > Date.now()) return true
  const probe = await fetch(destination('/v1/models'), { headers: headers as HeadersInit, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  if (!probe.ok) {
    event.node.res.statusCode = probe.status
    event.node.res.setHeader('content-type', probe.headers.get('content-type') || 'application/json')
    event.node.res.end(await probe.text())
    return false
  }
  await probe.body?.cancel()
  if (verifiedKeys.size >= 128) verifiedKeys.delete(verifiedKeys.keys().next().value!)
  verifiedKeys.set(fingerprint, Date.now() + 2_000)
  return true
}

/** Stream native requests and replies without changing their protocol or credentials. */
export async function forwardNativeCpa(event: H3Event, path: string, body?: Record<string, unknown>) {
  const url = destination(path)
  const headers = copyHeaders(event.node.req.headers)
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

/** Public native entry also accepts the original CCM keys, while the internal /v1 callback stays separate. */
export async function handleNexusInference(event: H3Event) {
  const requested = getRequestURL(event)
  const path = requested.pathname.replace(/^\/nexus\/cpa\/v1\//, '')
  const protocol = PROTOCOLS.get(path as 'chat/completions' | 'messages' | 'responses')
  if (path !== 'models' && !protocol) { fail(event, path, 404, 'Unsupported model endpoint'); return }
  const authorization = event.node.req.headers.authorization
  const apiKey = event.node.req.headers['x-api-key']
  const secret = typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, '').trim() : typeof apiKey === 'string' ? apiKey.trim() : ''
  if (secret.startsWith('ccm_')) return handleCommandcodeCompatibility(event, { protocolPath: path })
  try {
    let body: Record<string, unknown> | undefined
    if (protocol && event.method === 'POST' && await isModuleEnabled('presets')) {
        if (!await verifyBeforePreset(event)) return
        if (event.node.req.headers['content-encoding']) { fail(event, path, 415, 'Preset routes require an uncompressed JSON request'); return }
        body = await readJsonBodyLimited(event, (await getSettings()).maxRequestBodyMb * 1024 * 1024)
        // This model belongs to the CommandCode module; its selected account applies its own preset once.
        if (!(typeof body.model === 'string' && body.model.startsWith('commandcode/'))) {
          const accountId = typeof body.model === 'string' ? await findCpaPresetAccountForModel(body.model) : null
          const preset = await resolvePresetRoute('cpa', accountId)
          if (preset) { body = applyPreset(preset, body, { protocol }); event.node.res.setHeader('x-nexus-preset-id', preset.id) }
        }
    }
    return await forwardNativeCpa(event, '/v1/' + path + requested.search, body)
  } catch (error) {
    if (event.node.res.headersSent) { event.node.res.destroy(); return }
    const status = Number((error as { statusCode?: number }).statusCode) || (/timeout/i.test(String(error)) ? 504 : 502)
    fail(event, path, status, status < 500 && error instanceof Error ? error.message : 'CPA request failed; check the core connection')
  }
}
