import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createUnzip } from 'node:zlib'
import type { H3Event } from 'h3'
import { CPA_DEFAULT_URL, validateCpaBaseUrl } from './client'
import { CPA_GROUP_POLICY_HEADER } from './group-policy'
import { privacyHeaders } from '../privacy-headers'
import { getConfig } from '../config'
import { BILLING_USAGE_POLICY_HEADER, type BillingUsageObserver } from '../billing'
import { DiagnosticResponseFilter } from '../diagnostic-response'
import { writeWithBackpressure } from '../http/transport'
import { StreamOutcome } from '../routing/stream-outcome'

/**
 * Transport to the CPA kernel in two steps so a caller can look at the status
 * before anything reaches the client: `openCpaUpstream` resolves when CPA's
 * response headers arrive, then the caller either pipes the response or
 * discards it and tries the next source (multi-group failover).
 */
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
/** CPA's credential trace header names the selected auth index; it is recorded, never shown to clients. */
export const CPA_TRACE_HEADER = 'x-cpa-trace-id'

export function copyHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionTokens = String(source.connection || '').toLowerCase().split(',').map(token => token.trim())
  return Object.fromEntries(Object.entries(source).filter(([name]) => !HOP_HEADERS.has(name) && !connectionTokens.includes(name)))
}

function cpaUrl(path: string) {
  return new URL(path, validateCpaBaseUrl(process.env.CPA_URL || CPA_DEFAULT_URL))
}

/**
 * Client headers for CPA. With a platform key the caller's credentials are
 * replaced by the internal CPA client key; native keys pass through.
 */
export function cpaRequestHeaders(event: H3Event, clientKey?: string): IncomingHttpHeaders {
  const input = copyHeaders(event.node.req.headers)
  const hasSession = ['x-session-id', 'session_id', 'x-claude-code-session-id', 'x-codex-session-id'].some(name => typeof input[name] === 'string')
  const headers = privacyHeaders(input, hasSession ? getConfig().encryptionKey : undefined)
  for (const name of Object.keys(headers)) if (name.startsWith('x-nexus-')) delete headers[name]
  if (clientKey) {
    for (const name of Object.keys(headers)) {
      if (name === 'cookie' || name === 'x-api-key' || name === 'x-goog-api-key') delete headers[name]
    }
    headers.authorization = 'Bearer ' + clientKey
  }
  return headers
}

export interface CpaUpstream { response: IncomingMessage; request: ClientRequest }

export interface OpenCpaInput {
  event: H3Event
  /** Path and query on CPA, e.g. `/v1/chat/completions`. */
  path: string
  method?: string
  /** JSON body to send. Omit to stream the client's own request body. */
  body?: Record<string, unknown>
  clientKey?: string
  policy?: string
  /** Signed bridge route headers forwarded verbatim to a module bridge channel. */
  extraHeaders?: Record<string, string>
  timeoutMs: number
}

export function openCpaUpstream(input: OpenCpaInput): Promise<CpaUpstream> {
  const url = cpaUrl(input.path)
  const headers = cpaRequestHeaders(input.event, input.clientKey)
  // Inspect diagnostics as text even when the caller advertises compression.
  headers['accept-encoding'] = 'identity'
  if (input.policy) headers[CPA_GROUP_POLICY_HEADER] = input.policy
  for (const [name, value] of Object.entries(input.extraHeaders || {})) headers[name.toLowerCase()] = value
  let payload: Buffer | undefined
  if (input.body) {
    payload = Buffer.from(JSON.stringify(input.body))
    headers['content-length'] = String(payload.byteLength)
    headers['content-type'] = 'application/json'
    delete headers['content-encoding']
  }
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const request = send(url, { method: input.method || input.event.method, headers }, response => resolve({ response, request }))
    request.setTimeout(input.timeoutMs, () => request.destroy(Object.assign(new Error('CPA upstream idle timeout'), { statusCode: 504 })))
    request.once('error', reject)
    if (payload) request.end(payload)
    else input.event.node.req.pipe(request)
  })
}

/** Read a (small) error body from a response that will not be shown to the client. */
export async function readUpstreamText(response: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk)
      size += buffer.byteLength
      if (size > limit) break
      chunks.push(buffer)
    }
  } catch { /* A broken error body is still a failed attempt. */ }
  response.destroy()
  return Buffer.concat(chunks).toString('utf8')
}

export function parseTraceAuthIndex(value: string | string[] | undefined): string | null {
  // `<yyyymmddhhmmss>-<authIndex>-<requestId>`
  const match = typeof value === 'string' ? /^\d{14}-([^-]+)-/.exec(value.trim()) : null
  return match ? match[1]! : null
}

export interface PipeResult { status: number; streaming: boolean; outcome: StreamOutcome; authIndex: string | null }

/** Stream an opened CPA response to a model API caller. Errors are cleaned for callers (public-errors); `rewrite` replaces exact strings such as a bridge alias. */
export function pipeCpaResponse(event: H3Event, upstream: CpaUpstream, options: { usageObserver?: BillingUsageObserver; capture?: { push(chunk: Uint8Array): void }; timeoutMs: number; rewrite?: [string, string][] }): Promise<PipeResult> {
  const { response, request } = upstream
  const status = response.statusCode || 502
  const contentType = String(response.headers['content-type'] || '')
  const streaming = /text\/event-stream/i.test(contentType)
  const outcome = new StreamOutcome(status, streaming)
  const authIndex = parseTraceAuthIndex(response.headers[CPA_TRACE_HEADER])
  const inspect = status >= 400 || /^(?:text\/event-stream|application\/(?:[\w.+-]*\+)?json)(?:;|$)/i.test(contentType)
  const res = event.node.res
  res.statusCode = status
  for (const [name, value] of Object.entries(copyHeaders(response.headers))) {
    if (inspect && ['content-length', 'content-encoding', 'etag', 'last-modified', 'content-md5', 'digest'].includes(name)) continue
    if (value === undefined || name === BILLING_USAGE_POLICY_HEADER || name === CPA_TRACE_HEADER) continue
    res.setHeader(name, value)
  }
  res.setHeader('x-accel-buffering', 'no')
  request.setTimeout(options.timeoutMs, () => request.destroy(new Error('CPA upstream idle timeout')))
  return new Promise<PipeResult>((resolve, reject) => {
    const downstream = new AbortController()
    const done = () => resolve({ status, streaming, outcome, authIndex })
    const cleanup = () => { res.off('close', closed); res.off('finish', finished) }
    const finished = () => { cleanup(); done() }
    const closed = () => {
      if (!res.writableFinished) { outcome.cancelled = true; downstream.abort(); request.destroy(); response.destroy() }
      cleanup(); done()
    }
    res.once('close', closed)
    res.once('finish', finished)
    response.on('error', error => { cleanup(); reject(error) })
    response.on('aborted', () => { cleanup(); reject(new Error('CPA response interrupted')) })
    if (res.destroyed) { closed(); return }
    if (!inspect) {
      response.on('data', chunk => { const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); options.usageObserver?.push(raw); outcome.push(raw) })
      response.on('end', () => { options.usageObserver?.end(); outcome.end() })
      response.pipe(res)
      return
    }
    const filter = new DiagnosticResponseFilter(status, contentType, true, { publicErrors: true, rewrite: options.rewrite })
    const encoding = String(response.headers['content-encoding'] || '').toLowerCase()
    const source = encoding === 'br' ? response.pipe(createBrotliDecompress())
      : ['gzip', 'deflate'].includes(encoding) ? response.pipe(createUnzip()) : response
    void (async () => {
      for await (const chunk of source) {
        const raw = Buffer.from(chunk)
        options.usageObserver?.push(raw)
        options.capture?.push(raw)
        outcome.push(raw)
        for (const safe of filter.push(raw)) await writeWithBackpressure(res, safe, downstream.signal)
      }
      options.usageObserver?.end()
      outcome.end()
      for (const safe of filter.end()) await writeWithBackpressure(res, safe, downstream.signal)
      res.end()
    })().catch(error => { cleanup(); reject(error) })
  })
}

/** Open and stream in one step (native keys and requests without failover). */
export async function forwardCpa(input: OpenCpaInput & { usageObserver?: BillingUsageObserver }): Promise<PipeResult> {
  const upstream = await openCpaUpstream(input)
  return pipeCpaResponse(input.event, upstream, { usageObserver: input.usageObserver, timeoutMs: input.timeoutMs })
}
