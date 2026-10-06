import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http'
import type { H3Event } from 'h3'
import { getDevin2ApiRuntimeConfig } from './client'
import { resolveDevin2ApiModel } from './routing'
import { stripDevin2ApiModel } from './catalog'

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function copyHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionTokens = String(source.connection || '').toLowerCase().split(',').map(token => token.trim())
  return Object.fromEntries(Object.entries(source).filter(([name]) => !HOP_HEADERS.has(name) && !connectionTokens.includes(name)))
}
function failStatus(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

export interface ForwardDevin2ApiOptions {
  /** Caller may provide a parsed body so presets can be applied before forwarding. */
  body?: Record<string, unknown>
  baseUrl?: string
  apiKey?: string
  /** If supplied, enforce a Devin account binding before the request leaves Nexus. */
  groupIds?: string[]
}

/** Stream one of the OpenAI-compatible Devin protocols through the internal sidecar. */
export async function forwardDevin2Api(event: H3Event, protocolPath: string, options: ForwardDevin2ApiOptions = {}): Promise<void> {
  const rawPath = protocolPath.startsWith('/') ? protocolPath : '/' + protocolPath
  if (!/^\/v1\/(?:chat\/completions|messages|responses)(?:\?.*)?$/.test(rawPath)) throw failStatus('Unsupported Devin protocol endpoint', 404)
  let body = options.body
  let baseUrl = options.baseUrl
  if (options.groupIds && body && typeof body.model === 'string') {
    const selected = await resolveDevin2ApiModel(body.model, options.groupIds)
    if (!selected) throw failStatus('当前 Key 的分组中没有可调用的这个 Devin 模型', 404)
    // `base_url` belongs to the Devin upstream configuration consumed by the
    // sidecar. Nexus always calls the sidecar endpoint itself; using the
    // account value here would bypass the adapter and lose its auth/session
    // handling.
    body = { ...body, model: selected.model }
  } else if (body && typeof body.model === 'string') {
    const model = stripDevin2ApiModel(body.model)
    if (model) body = { ...body, model }
  }

  const runtime = getDevin2ApiRuntimeConfig()
  const targetBaseUrl = baseUrl || runtime.baseUrl
  if (!targetBaseUrl) throw failStatus('Missing DEVIN2API_URL configuration', 503)
  const parsed = new URL(targetBaseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw failStatus('Invalid DEVIN2API_URL configuration', 500)
  const url = new URL(rawPath, parsed)
  const headers = copyHeaders(event.node.req.headers)
  for (const name of Object.keys(headers)) if (/^(authorization|x-api-key|content-length|content-encoding)$/i.test(name)) delete headers[name]
  const key = options.apiKey === undefined ? runtime.apiKey : options.apiKey?.trim()
  if (key) headers['x-api-key'] = key
  let transformed: Buffer | undefined
  if (body !== undefined) {
    transformed = Buffer.from(JSON.stringify(body))
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(transformed.byteLength)
  }
  await new Promise<void>((resolve, reject) => {
    let reply: IncomingMessage | undefined
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: event.method, headers } as RequestOptions, response => {
      reply = response
      event.node.res.statusCode = response.statusCode || 502
      for (const [name, value] of Object.entries(copyHeaders(response.headers))) if (value !== undefined) event.node.res.setHeader(name, value)
      event.node.res.setHeader('x-accel-buffering', 'no')
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('Devin sidecar response interrupted')))
      response.pipe(event.node.res)
    })
    const cleanup = () => { event.node.res.off('close', closed); event.node.res.off('finish', finished) }
    const finished = () => { cleanup(); resolve() }
    const closed = () => {
      if (!event.node.res.writableFinished) { request.destroy(); reply?.destroy() }
      cleanup(); resolve()
    }
    event.node.res.once('close', closed)
    event.node.res.once('finish', finished)
    request.setTimeout(120_000, () => request.destroy(new Error('Devin sidecar upstream idle timeout')))
    request.on('error', error => { cleanup(); reject(error) })
    if (event.node.res.destroyed) { closed(); return }
    if (transformed) request.end(transformed)
    else event.node.req.pipe(request)
  })
}

export const handleDevin2ApiForward = forwardDevin2Api
