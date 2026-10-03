import { createError, defineEventHandler, getHeader, readRawBody, send, setHeader, setResponseStatus } from 'h3'
import { CpaClientError, createCpaClient } from '../../../lib/cpa/client'
import { cpaDownstreamAbort } from '../../../lib/cpa/http'

const PREFIX = '/api/cpa/management/'
const MAX_BODY_BYTES = 32 * 1024 * 1024

export default defineEventHandler(async event => {
  setHeader(event, 'X-Nexus-Upstream', 'cpa')
  // Validate the original request target before URL parsers can normalize traversal.
  const target = event.node.req.url || ''
  const question = target.indexOf('?')
  const pathname = question < 0 ? target : target.slice(0, question)
  if (!pathname.startsWith(PREFIX)) throw createError({ statusCode: 400, message: 'CPA 管理路径无效', data: { code: 'invalid_path', message: 'CPA 管理路径无效' } })
  const declared = Number(getHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw createError({ statusCode: 413, message: 'CPA 管理请求体过大', data: { code: 'request_too_large', message: 'CPA 管理请求体过大' } })
  const downstream = cpaDownstreamAbort(event)
  try {
    const rawBody = ['GET', 'HEAD'].includes(event.method) ? undefined : await readRawBody(event, false)
    if (rawBody && rawBody.byteLength > MAX_BODY_BYTES) throw createError({ statusCode: 413, message: 'CPA 管理请求体过大', data: { code: 'request_too_large', message: 'CPA 管理请求体过大' } })
    const response = await createCpaClient().request({
      path: pathname.slice(PREFIX.length), method: event.method,
      query: new URLSearchParams(question < 0 ? '' : target.slice(question + 1)),
      body: rawBody ? new Uint8Array(rawBody).buffer : undefined,
      headers: { 'content-type': getHeader(event, 'content-type') || 'application/json', accept: getHeader(event, 'accept') || '*/*' },
      signal: downstream.signal,
    })
    setResponseStatus(event, response.status)
    for (const [key, value] of response.headers) setHeader(event, key, value)
    return send(event, Buffer.from(response.body))
  } catch (error) {
    if (error instanceof CpaClientError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code, message: error.message } })
    throw error
  } finally { downstream.dispose() }
})
