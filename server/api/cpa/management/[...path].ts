import { createError, defineEventHandler, getHeader, readRawBody, send, setHeader, setResponseStatus } from 'h3'
import { CpaClientError, cpaPathSegments, createCpaClient } from '../../../lib/cpa/client'
import { cpaDownstreamAbort } from '../../../lib/cpa/http'

const PREFIX = '/api/cpa/management/'
const MAX_BODY_BYTES = 32 * 1024 * 1024
const ACCESS_KEYS_PATH = 'config/access/api-keys'

function parseAccessKeys(body: Uint8Array): string[] {
  let keys: unknown
  try { keys = JSON.parse(new TextDecoder().decode(body)) } catch { /* Return one bounded validation error below. */ }
  if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))) {
    throw createError({ statusCode: 400, message: 'CPA 客户端密钥必须是非空字符串数组', data: { code: 'invalid_body', message: 'CPA 客户端密钥必须是非空字符串数组' } })
  }
  return keys
}

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
    const path = cpaPathSegments(pathname.slice(PREFIX.length)).join('/')
    const reservedKey = process.env.CPA_CLIENT_KEY?.trim()
    const protectAccessKeys = path === ACCESS_KEYS_PATH && !!reservedKey
    if (protectAccessKeys && /[\r\n]/.test(reservedKey)) throw new CpaClientError('invalid_configuration', 'CPA_CLIENT_KEY 配置无效', 503)
    let body = rawBody ? new Uint8Array(rawBody).buffer : undefined
    let method = event.method
    if (protectAccessKeys && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
      const keys = method === 'DELETE' ? [] : parseAccessKeys(rawBody || new Uint8Array())
      body = new TextEncoder().encode(JSON.stringify([...new Set([...keys, reservedKey])])).buffer
      // Deleting the client node revokes historical keys but retains the private
      // credential used by unified model keys and CommandCode protocol conversion.
      method = 'PUT'
    }
    const response = await createCpaClient().request({
      path, method,
      query: new URLSearchParams(question < 0 ? '' : target.slice(question + 1)),
      body,
      headers: { 'content-type': getHeader(event, 'content-type') || 'application/json', accept: getHeader(event, 'accept') || '*/*' },
      signal: downstream.signal,
    })
    setResponseStatus(event, response.status)
    for (const [key, value] of response.headers) setHeader(event, key, value)
    if (path === ACCESS_KEYS_PATH && event.method === 'GET' && response.status >= 200 && response.status < 300) {
      let keys: unknown
      try { keys = JSON.parse(new TextDecoder().decode(response.body)) } catch { /* Unknown format has no reserved row. */ }
      setHeader(event, 'X-Nexus-Reserved-Key-Index', String(Array.isArray(keys) && reservedKey ? keys.indexOf(reservedKey) : -1))
    }
    return send(event, Buffer.from(response.body))
  } catch (error) {
    if (error instanceof CpaClientError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code, message: error.message } })
    throw error
  } finally { downstream.dispose() }
})
