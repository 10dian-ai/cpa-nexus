import { request as httpRequest } from 'node:http'
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'

export interface Devin2ApiClientOptions {
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export interface Devin2ApiRequest {
  path: string
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  signal?: AbortSignal
  /** Apply only to requests which are expected to finish promptly (health/models). */
  timeoutMs?: number
}

export interface Devin2ApiClient {
  readonly baseUrl: string
  request(input: Devin2ApiRequest): Promise<Response>
  health(): Promise<Response>
  listModels(): Promise<Response>
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

/**
 * Read the sidecar endpoint without requiring the regular application config.
 * The sidecar is deployed separately and must be configured explicitly.
 */
export function getDevin2ApiRuntimeConfig(): Required<Pick<Devin2ApiClientOptions, 'baseUrl' | 'timeoutMs'>> & Pick<Devin2ApiClientOptions, 'apiKey'> {
  const baseUrl = text(process.env.DEVIN2API_URL || process.env.DEVIN_2API_URL)
  if (baseUrl) {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('Invalid DEVIN2API_URL configuration')
  }
  const rawTimeout = Number(process.env.DEVIN2API_TIMEOUT_MS || 15_000)
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(Math.floor(rawTimeout), 120_000) : 15_000
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey: text(process.env.DEVIN2API_API_KEY) || undefined, timeoutMs }
}

function pathName(path: string): string {
  const normalized = path.startsWith('/') ? path : '/' + path
  // A route path is assembled internally; reject absolute URLs to avoid SSRF by model input.
  if (/^\/\//.test(normalized) || normalized.includes('\\')) throw new Error('Invalid Devin sidecar path')
  return normalized
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal
  if (!signal) return AbortSignal.timeout(timeoutMs)
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  setTimeout(() => controller.abort(new Error('Devin sidecar request timed out')), timeoutMs).unref?.()
  return controller.signal
}

function headersWithAuth(headers: HeadersInit | undefined, apiKey: string | undefined): Headers {
  const result = new Headers(headers)
  // Never forward the caller's model key to the sidecar. Its credential is an internal secret.
  result.delete('authorization')
  result.delete('x-api-key')
  if (apiKey) result.set('x-api-key', apiKey)
  result.delete('host')
  return result
}

export function createDevin2ApiClient(options: Devin2ApiClientOptions = {}): Devin2ApiClient {
  const runtime = getDevin2ApiRuntimeConfig()
  const baseUrl = text(options.baseUrl) || runtime.baseUrl
  if (!baseUrl) throw new Error('Missing DEVIN2API_URL configuration')
  const parsed = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Invalid DEVIN2API_URL configuration')
  const apiKey = options.apiKey === undefined ? runtime.apiKey : text(options.apiKey) || undefined
  const timeoutMs = options.timeoutMs ?? runtime.timeoutMs
  const fetchImpl = options.fetch ?? globalThis.fetch
  const request = async (input: Devin2ApiRequest) => {
    const url = new URL(pathName(input.path), parsed)
    const timeout = input.timeoutMs === undefined ? undefined : input.timeoutMs
    const signal = combineSignals(input.signal, timeout)
    return fetchImpl(url, {
      method: input.method || 'GET',
      headers: headersWithAuth(input.headers, apiKey),
      body: input.body,
      ...(signal ? { signal } : {}),
    })
  }
  return {
    baseUrl: parsed.toString().replace(/\/$/, ''),
    request,
    health: () => request({ path: '/healthz', timeoutMs }),
    listModels: () => request({ path: '/v1/models', timeoutMs }),
  }
}

/**
 * Stream a protocol request through Node's HTTP client. Fetch buffers neither
 * side, but this helper makes backpressure and client disconnect handling
 * explicit for SSE responses in h3.
 */
export interface Devin2ApiStreamInput {
  baseUrl?: string
  apiKey?: string
  path: string
  method: string
  headers: IncomingHttpHeaders
  body?: Buffer
  onResponse: (response: IncomingMessage) => void
  onError?: (error: Error) => void
}

export function streamDevin2Api(input: Devin2ApiStreamInput): { request: ReturnType<typeof httpRequest> } {
  const runtime = getDevin2ApiRuntimeConfig()
  const baseUrl = text(input.baseUrl) || runtime.baseUrl
  if (!baseUrl) throw new Error('Missing DEVIN2API_URL configuration')
  const parsed = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Invalid DEVIN2API_URL configuration')
  const url = new URL(pathName(input.path), parsed)
  const headers: Record<string, string | string[] | undefined> = { ...input.headers }
  for (const name of Object.keys(headers)) {
    if (/^(authorization|x-api-key|host|content-length|connection|transfer-encoding)$/i.test(name)) delete headers[name]
  }
  const apiKey = input.apiKey === undefined ? runtime.apiKey : text(input.apiKey) || undefined
  if (apiKey) headers['x-api-key'] = apiKey
  if (input.body) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(input.body.byteLength)
  }
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: input.method, headers } as HttpsRequestOptions, response => input.onResponse(response))
  request.on('error', error => input.onError?.(error))
  if (input.body) request.end(input.body)
  else request.end()
  return { request }
}
