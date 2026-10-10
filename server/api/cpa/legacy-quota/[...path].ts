import { createError, defineEventHandler, readRawBody, send, setHeader, setResponseStatus } from 'h3'
import { CpaClientError, cpaPathSegments, createCpaClient } from '../../../lib/cpa/client'
import { cpaDownstreamAbort } from '../../../lib/cpa/http'
import { requireAdmin } from '../../../lib/auth'
import { redactManagementResponse } from '../../../lib/diagnostic-response'
export default defineEventHandler(async event => {
  await requireAdmin(event)
  const original = event.node.req.url || ''
  const target = original.split('?')[0] || ''
  const prefix = '/api/cpa/legacy-quota/'
  if (!target.startsWith(prefix)) throw createError({ statusCode: 400, message: '配额路径无效' })
  const downstream = cpaDownstreamAbort(event)
  try {
    const body = event.method === 'GET' ? undefined : await readRawBody(event, false)
    const response = await createCpaClient().legacyQuotaRequest({ path: 'quota/' + cpaPathSegments(target.slice(prefix.length)).join('/'), method: event.method, body: body ? new Uint8Array(body).buffer : undefined, headers: { 'content-type': 'application/json' }, signal: downstream.signal })
    redactManagementResponse('quota', response)
    setResponseStatus(event, response.status)
    for (const [key, value] of response.headers) setHeader(event, key, value)
    return send(event, Buffer.from(response.body))
  } catch (error) {
    if (error instanceof CpaClientError) throw createError({ statusCode: error.statusCode, message: error.message })
    throw error
  } finally { downstream.dispose() }
})
