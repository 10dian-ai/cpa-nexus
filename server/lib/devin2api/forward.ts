import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http'
import type { H3Event } from 'h3'
import type { Devin2ApiSelection } from './routing'
import { resolveDevin2ApiModel } from './routing'
import { stripDevin2ApiModel } from './catalog'
import { acquireDevin2ApiRuntimeLease } from './runtime'
import type { BillingUsageObserver } from '../billing'

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function copyHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionTokens = String(source.connection || '').toLowerCase().split(',').map(token => token.trim())
  return Object.fromEntries(Object.entries(source).filter(([name]) => !HOP_HEADERS.has(name) && !connectionTokens.includes(name)))
}
const failStatus = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode })
export interface ForwardDevin2ApiOptions {
  body?: Record<string, unknown>
  groupIds?: string[]
  selection?: Devin2ApiSelection
  usageObserver?: BillingUsageObserver
}
/** Stream a request through the account-specific embedded runtime. */
export async function forwardDevin2Api(event: H3Event, protocolPath: string, options: ForwardDevin2ApiOptions = {}): Promise<void> {
  const rawPath = protocolPath.startsWith('/') ? protocolPath : '/' + protocolPath
  if (!/^\/v1\/(?:chat\/completions|messages|responses)(?:\?.*)?$/.test(rawPath)) throw failStatus('Unsupported Devin protocol endpoint', 404)
  let body = options.body
  let selection = options.selection
  if (!selection && options.groupIds && body && typeof body.model === 'string') selection = await resolveDevin2ApiModel(body.model, options.groupIds) || undefined
  if (!selection) throw failStatus('当前 Key 的分组中没有可调用的这个 Devin 模型', 404)
  if (body && typeof body.model === 'string') {
    const model = stripDevin2ApiModel(body.model)
    if (model) body = { ...body, model }
    else if (body.model !== selection.model) body = { ...body, model: selection.model }
  }
  const lease = await acquireDevin2ApiRuntimeLease({
    id: selection.account.id, baseUrl: selection.account.baseUrl, model: selection.account.model,
    proxy: selection.account.proxy, maxConcurrency: (selection.account as any).maxConcurrency || 2,
  })
  const endpoint = new URL(rawPath, lease.baseUrl)
  const headers = copyHeaders(event.node.req.headers)
  for (const name of Object.keys(headers)) {
    if (/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key|content-length|content-encoding)$/i.test(name) || /^x-nexus-/i.test(name)) delete headers[name]
  }
  headers['x-api-key'] = lease.apiKey
  let transformed: Buffer | undefined
  if (body !== undefined) {
    transformed = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json'; headers['content-length'] = String(transformed.byteLength)
  }
  await new Promise<void>((resolve, reject) => {
    let reply: IncomingMessage | undefined; let settled = false
    const release = () => { if (!settled) { settled = true; lease.release() } }
    const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, { method: event.method, headers } as RequestOptions, response => {
      reply = response; event.node.res.statusCode = response.statusCode || 502
      for (const [name, value] of Object.entries(copyHeaders(response.headers))) {
        if (/^(set-cookie|authorization|proxy-authenticate|x-api-key|x-goog-api-key)$/i.test(name) || /^x-nexus-/i.test(name)) continue
        if (value !== undefined) event.node.res.setHeader(name, value)
      }
      event.node.res.setHeader('x-accel-buffering', 'no')
      response.on('error', error => { release(); reject(error) })
      response.on('aborted', () => { release(); reject(new Error('Devin embedded runtime response interrupted')) })
      if (options.usageObserver) {
        response.on('data', chunk => options.usageObserver!.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on('end', () => options.usageObserver!.end())
      }
      response.pipe(event.node.res)
    })
    const cleanup = () => { event.node.res.off('close', closed); event.node.res.off('finish', finished) }
    const finished = () => { cleanup(); release(); resolve() }
    const closed = () => { if (!event.node.res.writableFinished) { request.destroy(); reply?.destroy() }; cleanup(); release(); resolve() }
    event.node.res.once('close', closed); event.node.res.once('finish', finished)
    request.setTimeout(120_000, () => request.destroy(new Error('Devin embedded runtime idle timeout')))
    request.on('error', error => { cleanup(); release(); reject(error) })
    if (event.node.res.destroyed) { closed(); return }
    if (transformed) request.end(transformed); else event.node.req.pipe(request)
  })
}
export const handleDevin2ApiForward = forwardDevin2Api
