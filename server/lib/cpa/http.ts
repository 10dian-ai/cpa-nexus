import { createError, getHeader, readRawBody, send, setHeader, setResponseStatus, type H3Event } from 'h3'
import { CpaClientError, createCpaClient } from './client'
import { redactManagementResponse } from '../diagnostic-response'


export function cpaDownstreamAbort(event: H3Event) {
  const controller = new AbortController()
  const aborted = () => controller.abort()
  const closed = () => { if (!event.node.res.writableEnded) controller.abort() }
  event.node.req.once('aborted', aborted)
  event.node.res.once('close', closed)
  if (event.node.req.aborted || event.node.res.destroyed) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => { event.node.req.off('aborted', aborted); event.node.res.off('close', closed) },
  }
}

/** Keep plugin-owned URLs on the authenticated Nexus proxy when serving text assets. */
export function adaptCpaResourceBody(body: Uint8Array, contentType: string): Uint8Array {
  if (!/^(?:text\/html|text\/css|text\/javascript|application\/(?:javascript|x-javascript))(?:;|$)/i.test(contentType)
    || (/charset=/i.test(contentType) && !/charset=["']?utf-?8/i.test(contentType))) return body
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(body) } catch { return body }
  const adapted = source.replaceAll('/v0/resource/plugins/', '/api/cpa/resources/')
    .replaceAll('/v0/management/', '/api/cpa/plugin-management/')
  return adapted === source ? body : new TextEncoder().encode(adapted)
}

export async function proxyCpaPlugin(event: H3Event, kind: 'resource' | 'management') {
  setHeader(event, 'X-Nexus-Upstream', 'cpa')
  const prefix = kind === 'resource' ? '/api/cpa/resources/' : '/api/cpa/plugin-management/'
  const target = event.node.req.url || ''
  const question = target.indexOf('?')
  const pathname = question < 0 ? target : target.slice(0, question)
  if (!pathname.startsWith(prefix)) throw createError({ statusCode: 400, message: 'CPA 插件路径无效', data: { code: 'invalid_path', message: 'CPA 插件路径无效' } })
  const downstream = cpaDownstreamAbort(event)
  try {
    const body = ['GET', 'HEAD'].includes(event.method) ? undefined : await readRawBody(event, false)
    const response = await createCpaClient().pluginRequest({
      kind, path: pathname.slice(prefix.length), method: event.method,
      query: new URLSearchParams(question < 0 ? '' : target.slice(question + 1)), body: body ? new Uint8Array(body).buffer : undefined,
      headers: { 'content-type': getHeader(event, 'content-type') || 'application/json', accept: getHeader(event, 'accept') || '*/*' },
      signal: downstream.signal,
    })
    redactManagementResponse(pathname.slice(prefix.length), response)
    if (kind === 'resource') {
      const adapted = adaptCpaResourceBody(response.body, response.headers.get('content-type') || '')
      if (adapted !== response.body) { response.body = adapted; response.headers.delete('etag'); response.headers.delete('last-modified') }
    }
    setResponseStatus(event, response.status)
    for (const [key, value] of response.headers) setHeader(event, key, value)
    return send(event, Buffer.from(response.body))
  } catch (error) {
    if (error instanceof CpaClientError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code, message: error.message } })
    throw error
  } finally { downstream.dispose() }
}
