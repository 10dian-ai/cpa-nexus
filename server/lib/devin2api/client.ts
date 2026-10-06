import type { IncomingHttpHeaders } from 'node:http'

export interface Devin2ApiClientOptions {
  /** Loopback endpoint returned by the embedded runtime manager. */
  baseUrl?: string
  /** Per-runtime API key; never read from application environment. */
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
  timeoutMs?: number
}
export interface Devin2ApiClient {
  readonly baseUrl: string
  request(input: Devin2ApiRequest): Promise<Response>
  health(): Promise<Response>
  listModels(): Promise<Response>
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
export const getDevin2ApiRuntimeConfig = () => {
  const raw = Number(process.env.DEVIN2API_TIMEOUT_MS || 15_000)
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 120_000) : 15_000
  return { baseUrl: '', apiKey: undefined, timeoutMs }
}
function pathName(path: string): string {
  const normalized = path.startsWith('/') ? path : '/' + path
  if (/^\/\//.test(normalized) || normalized.includes('\\')) throw new Error('Invalid Devin runtime path')
  return normalized
}
function checkedUrl(baseUrl: string): URL {
  if (!baseUrl) throw new Error('Missing embedded Devin runtime endpoint')
  const parsed = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Invalid embedded Devin runtime endpoint')
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('Devin runtime endpoint must be loopback')
  return parsed
}
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return signal
  timeoutMs = Math.min(Math.floor(timeoutMs), 120_000)
  if (!signal) return AbortSignal.timeout(timeoutMs)
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Devin runtime request timed out')), timeoutMs)
  timer.unref?.()
  return controller.signal
}
function headersWithAuth(headers: HeadersInit | undefined, apiKey: string | undefined): Headers {
  const result = new Headers(headers)
  for (const name of [...result.keys()]) {
    if (/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key)$/i.test(name) || /^x-nexus-/i.test(name)) result.delete(name)
  }
  if (apiKey) result.set('x-api-key', apiKey)
  result.delete('host')
  return result
}

/** Create a client for an endpoint leased from the in-process Devin runtime. */
export function createDevin2ApiClient(options: Devin2ApiClientOptions = {}): Devin2ApiClient {
  const runtime = getDevin2ApiRuntimeConfig()
  const parsed = checkedUrl(text(options.baseUrl))
  const apiKey = text(options.apiKey) || undefined
  const timeoutMs = options.timeoutMs ?? runtime.timeoutMs
  const fetchImpl = options.fetch ?? globalThis.fetch
  const request = async (input: Devin2ApiRequest) => {
    const signal = combineSignals(input.signal, input.timeoutMs === undefined ? undefined : input.timeoutMs)
    return fetchImpl(new URL(pathName(input.path), parsed), {
      method: input.method || 'GET', headers: headersWithAuth(input.headers, apiKey), body: input.body,
      ...(signal ? { signal } : {}),
    })
  }
  return { baseUrl: parsed.toString().replace(/\/$/, ''), request, health: () => request({ path: '/healthz', timeoutMs }), listModels: () => request({ path: '/v1/models', timeoutMs }) }
}

// Kept as a small compatibility helper for direct protocol tests. In production,
// forward.ts acquires an account lease and performs the stream itself.
export interface Devin2ApiStreamInput {
  baseUrl: string; apiKey: string; path: string; method: string; headers: IncomingHttpHeaders; body?: Buffer
  onResponse: (response: import('node:http').IncomingMessage) => void; onError?: (error: Error) => void
}
export function streamDevin2Api(_input: Devin2ApiStreamInput): never {
  throw new Error('streamDevin2Api requires a leased embedded runtime; use forwardDevin2Api')
}
