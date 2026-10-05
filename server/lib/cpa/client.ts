import type { CpaStatus } from '../../../shared/cpa'
import { resolveCpaPluginRequest, type CpaPluginRequest, type CpaPluginRoute } from './plugins'

export const CPA_DEFAULT_URL = 'http://cpa:8317'
export const CPA_MANAGEMENT_PREFIX = '/v8/management/'
const DEFAULT_TIMEOUT_MS = 15_000
const LONG_OPERATION_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = Number.POSITIVE_INFINITY

export class CpaClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: number) {
    super(message)
    this.name = 'CpaClientError'
  }
}

export interface CpaClientOptions {
  baseUrl?: string
  managementKey?: string
  clientKey?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  longOperationTimeoutMs?: number
  maxResponseBytes?: number
  pluginRoutes?: CpaPluginRoute[]
}

export interface CpaRequest {
  /** Relative official v8 management path, without a leading slash or query. */
  path: string
  method?: string
  query?: URLSearchParams | Record<string, string | number | boolean>
  body?: BodyInit | null
  headers?: HeadersInit
  signal?: AbortSignal
}

export interface CpaResponse {
  status: number
  statusText: string
  headers: Headers
  body: Uint8Array
}

export function cpaRequestTimeoutMs(request: Pick<CpaRequest, 'path' | 'method'>, options: Pick<CpaClientOptions, 'timeoutMs' | 'longOperationTimeoutMs'> = {}): number {
  const path = cpaPathSegments(request.path).join('/').replace(/^v[08]\/management\//, '')
  const longOperation = (request.method || 'GET').toUpperCase() === 'POST' &&
    (path === 'credentials/refresh' || path === 'requests/api-call' || path === 'quota/fetch' || path === 'quota/reset' || /^plugins\/store\/[^/]+\/install$/.test(path) || /^plugins\/[^/]+\/quota$/.test(path))
  const timeout = longOperation ? options.longOperationTimeoutMs ?? LONG_OPERATION_TIMEOUT_MS : options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return Math.min(LONG_OPERATION_TIMEOUT_MS, Math.max(1, timeout))
}

interface RouteContract { path: RegExp; methods: string[]; query?: string[] }
// The official v8.0.15 registration contract (server_management_v8.go).
// Keep this list explicit so an upgraded core cannot silently expose another API.
const routes: RouteContract[] = [
  { path: /^config$/, methods: ['GET', 'PUT', 'PATCH'] },
  { path: /^config\/[^/]+(?:\/[^/]+)*$/, methods: ['GET', 'PUT', 'PATCH', 'DELETE'] },
  { path: /^config\.yaml$/, methods: ['GET', 'PUT'] },
  { path: /^server\/latest-version$/, methods: ['GET'] },
  { path: /^requests\/api-call$/, methods: ['POST'] },
  { path: /^routing\/cooldown\/reset$/, methods: ['POST'] },
  { path: /^routing\/model-definitions\/[^/]+$/, methods: ['GET'] },
  { path: /^observability\/logs$/, methods: ['GET', 'DELETE'], query: ['after', 'limit', 'cursor'] },
  { path: /^observability\/logs\/errors(?:\/[^/]+)?$/, methods: ['GET'] },
  { path: /^observability\/logs\/requests\/[^/]+$/, methods: ['GET'] },
  { path: /^observability\/usage\/api-keys$/, methods: ['GET'] },
  { path: /^observability\/usage\/queue$/, methods: ['GET'], query: ['count'] },
  { path: /^credentials$/, methods: ['GET', 'POST', 'DELETE'], query: ['name', 'auth_index', 'all', 'page', 'page_size'] },
  { path: /^credentials\/(?:download|models)$/, methods: ['GET'], query: ['name'] },
  { path: /^credentials\/(?:status|fields)$/, methods: ['PATCH'] },
  { path: /^credentials\/refresh$/, methods: ['POST'], query: ['name', 'auth_index', 'all'] },
  { path: /^oauth\/auth-url$/, methods: ['GET'], query: ['provider', 'is_webui', 'domain', 'channel', 'project_id'] },
  { path: /^oauth\/status$/, methods: ['GET'], query: ['state'] },
  { path: /^oauth\/session$/, methods: ['DELETE'], query: ['state'] },
  { path: /^oauth\/import$/, methods: ['POST'], query: ['provider', 'location'] },
  { path: /^oauth\/callback$/, methods: ['GET', 'POST'], query: ['provider', 'state', 'code', 'error', 'error_description'] },
  { path: /^plugins$/, methods: ['GET'] },
  { path: /^plugins\/store$/, methods: ['GET'] },
  { path: /^plugins\/store\/[^/]+\/install$/, methods: ['POST'], query: ['source', 'version'] },
  { path: /^plugins\/[^/]+\/quota$/, methods: ['GET', 'POST', 'DELETE'], query: ['auth_index', 'authIndex'] },
  { path: /^plugins\/[^/]+$/, methods: ['DELETE'] },
  { path: /^nexus\/capabilities$/, methods: ['GET'] },
  { path: /^nexus\/group-policies$/, methods: ['POST'] },
]

export function validateCpaBaseUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new CpaClientError('invalid_configuration', 'CPA_URL 必须是有效的 HTTP 地址', 503) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new CpaClientError('invalid_configuration', 'CPA_URL 必须是没有凭证、路径或查询参数的 HTTP 服务地址', 503)
  }
  return url
}

export function cpaPathSegments(path: string): string[] {
  if (!path || path.length > 4096 || /^[\/\\]/.test(path) || /[?#\\\u0000-\u001f\u007f]/.test(path)) {
    throw new CpaClientError('invalid_path', 'CPA 管理路径无效', 400)
  }
  return path.split('/').map(segment => {
    let decoded: string
    try { decoded = decodeURIComponent(segment) } catch { throw new CpaClientError('invalid_path', 'CPA 管理路径编码无效', 400) }
    if (!decoded || decoded === '.' || decoded === '..' || /[/%?#\\\u0000-\u001f\u007f]/.test(decoded)) {
      throw new CpaClientError('invalid_path', 'CPA 管理路径无效', 400)
    }
    return decoded
  })
}

export function resolveCpaManagementRequest(baseUrl: string, request: Pick<CpaRequest, 'path' | 'method' | 'query'>) {
  const base = validateCpaBaseUrl(baseUrl)
  const segments = cpaPathSegments(request.path)
  const path = segments.join('/')
  const contract = routes.find(route => route.path.test(path))
  if (!contract) throw new CpaClientError('unsupported_path', '此 CPA 管理接口尚未适配', 404)
  const method = (request.method || 'GET').toUpperCase()
  if (!contract.methods.includes(method)) throw new CpaClientError('unsupported_method', '此 CPA 管理接口不支持该请求方法', 405)
  const query = request.query instanceof URLSearchParams ? request.query : new URLSearchParams(
    Object.entries(request.query || {}).map(([key, value]) => [key, String(value)]),
  )
  const seen = new Set<string>()
  for (const [key, value] of query) {
    if (!contract.query?.includes(key) || seen.has(key) || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new CpaClientError('invalid_query', 'CPA 管理查询参数无效', 400)
    }
    seen.add(key)
  }
  if (query.toString().length > 16384) throw new CpaClientError('invalid_query', 'CPA 管理查询参数过长', 400)
  const url = new URL(CPA_MANAGEMENT_PREFIX + segments.map(encodeURIComponent).join('/'), base)
  url.search = query.toString()
  return { url, method }
}

export async function readCpaResponseBody(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new CpaClientError('response_too_large', 'CPA 响应超过允许大小', 502)
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) throw new CpaClientError('response_too_large', 'CPA 响应超过允许大小', 502)
      parts.push(result.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const body = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { body.set(part, offset); offset += part.byteLength }
  return body
}

const responseHeaderNames = [
  'content-type', 'content-disposition', 'etag', 'last-modified', 'retry-after',
  'x-cpa-version', 'x-cpa-commit', 'x-cpa-build-date', 'x-cpa-support-plugin',
]

export function createCpaClient(options: CpaClientOptions = {}) {
  const baseUrl = options.baseUrl ?? (process.env.CPA_URL?.trim() || CPA_DEFAULT_URL)
  const managementKey = (options.managementKey ?? process.env.CPA_MANAGEMENT_KEY ?? '').trim()
  const fetcher = options.fetch ?? globalThis.fetch
  const maxBytes = Math.max(1, options.maxResponseBytes ?? MAX_RESPONSE_BYTES)

  const execute = async (input: CpaRequest, url: URL, method: string, authenticated: boolean | string = true): Promise<CpaResponse> => {
    if (!managementKey) throw new CpaClientError('not_configured', '尚未配置 CPA_MANAGEMENT_KEY', 503)
    if (/[\r\n]/.test(managementKey)) throw new CpaClientError('invalid_configuration', 'CPA 管理密钥配置无效', 503)
    if (input.signal?.aborted) throw new CpaClientError('cancelled', 'CPA 管理请求已取消', 499)
    const headers = new Headers({ accept: 'application/json' })
    if (authenticated) headers.set('authorization', 'Bearer ' + (typeof authenticated === 'string' ? authenticated : managementKey))
    // Never forward browser cookies, authorization, host or proxy headers.
    const supplied = new Headers(input.headers)
    for (const key of ['content-type', 'accept']) {
      const value = supplied.get(key)
      if (value) headers.set(key, value)
    }
    const controller = new AbortController()
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal
    const timeoutMs = cpaRequestTimeoutMs(input, options)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const cancelled = input.signal ? new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        controller.abort()
        reject(new CpaClientError('cancelled', 'CPA 管理请求已取消', 499))
      }
      input.signal!.addEventListener('abort', abortListener, { once: true })
    }) : undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new CpaClientError('timeout', 'CPA 管理请求超时', 504))
      }, timeoutMs)
    })
    const operation = async () => {
      const upstream = await fetcher(url, {
        method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : input.body,
        signal, redirect: 'manual',
      })
      const body = await readCpaResponseBody(upstream, maxBytes)
      if (Buffer.from(body).includes(Buffer.from(managementKey))) {
        throw new CpaClientError('sensitive_response', 'CPA 响应包含服务端管理凭证，无法返回', 502)
      }
      const responseHeaders = new Headers({ 'cache-control': 'no-store', 'x-nexus-upstream': 'cpa' })
      for (const key of responseHeaderNames) {
        const value = upstream.headers.get(key)
        if (value) responseHeaders.set(key, value)
      }
      return { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders, body }
    }
    try { return await Promise.race([operation(), timeout, ...(cancelled ? [cancelled] : [])]) }
    catch (error) {
      if (error instanceof CpaClientError) throw error
      if (input.signal?.aborted) throw new CpaClientError('cancelled', 'CPA 管理请求已取消', 499)
      if (controller.signal.aborted) throw new CpaClientError('timeout', 'CPA 管理请求超时', 504)
      // Do not include network errors, URLs, keys or upstream bodies in local failures.
      throw new CpaClientError('unreachable', '无法连接 CPA 内核', 502)
    } finally {
      if (timer) clearTimeout(timer)
      if (abortListener) input.signal?.removeEventListener('abort', abortListener)
    }
  }

  const request = (input: CpaRequest): Promise<CpaResponse> => {
    const { url, method } = resolveCpaManagementRequest(baseUrl, input)
    return execute(input, url, method)
  }

  /** Complete official console scope: fixed core only, authenticated by Nexus on every request. */
  const consoleRequest = async (input: CpaRequest): Promise<CpaResponse> => {
    const segments = cpaPathSegments(input.path)
    const path = segments.join('/')
    const resource = segments[0] === 'v0' && segments[1] === 'resource' && segments[2] === 'plugins' && segments.length >= 5
    const management = ['v0', 'v8'].includes(segments[0] || '') && segments[1] === 'management' && segments.length >= 3
    const models = path === 'v1/models'
    const method = (input.method || 'GET').toUpperCase()
    if (!resource && !management && !models) throw new CpaClientError('unsupported_path', '此路径不属于 CPA 原版控制台', 404)
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || ((resource || models) && !['GET', 'HEAD'].includes(method)))
      throw new CpaClientError('unsupported_method', 'CPA 原版接口不支持该请求方法', 405)
    const query = input.query instanceof URLSearchParams ? input.query : new URLSearchParams(Object.entries(input.query || {}).map(([key, value]) => [key, String(value)]))
    if ([...query].length > 64 || query.toString().length > 16384 || [...query].some(([key, value]) => key.length > 128 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(key + value)))
      throw new CpaClientError('invalid_query', 'CPA 原版查询参数过长或无效', 400)
    const url = new URL('/' + segments.map(encodeURIComponent).join('/'), validateCpaBaseUrl(baseUrl))
    url.search = query.toString()
    const modelKey = (options.clientKey ?? process.env.CPA_CLIENT_KEY ?? '').trim()
    if (models && (!modelKey || /[\r\n]/.test(modelKey))) throw new CpaClientError('not_configured', '尚未配置 CPA_CLIENT_KEY', 503)
    const result = await execute(input, url, method === 'HEAD' ? 'GET' : method, models ? modelKey : management)
    if (method === 'HEAD') result.body = new Uint8Array()
    return result
  }

  const legacyQuotaRequest = (input: CpaRequest): Promise<CpaResponse> => {
    const path = cpaPathSegments(input.path).join('/')
    const method = (input.method || 'GET').toUpperCase()
    if (!((path === 'quota/providers' && method === 'GET') || (['quota/fetch', 'quota/reset'].includes(path) && method === 'POST')))
      throw new CpaClientError('unsupported_path', '此接口不属于 CPA 原生配额管理', 404)
    return consoleRequest({ ...input, path: 'v0/management/' + path })
  }

  const nativePanelRequest = (signal?: AbortSignal): Promise<CpaResponse> => execute(
    { path: 'management.html', headers: { accept: 'text/html' }, signal },
    new URL('/management.html', validateCpaBaseUrl(baseUrl)), 'GET', false,
  )

  const pluginRequest = async (input: CpaPluginRequest): Promise<CpaResponse> => {
    const discovery = await request({ path: 'plugins', signal: input.signal })
    if (discovery.status < 200 || discovery.status >= 300) return discovery
    let plugins: unknown
    try { plugins = JSON.parse(new TextDecoder().decode(discovery.body)) }
    catch { throw new CpaClientError('invalid_response', 'CPA 插件发现接口返回无效响应', 502) }
    const { url, method } = resolveCpaPluginRequest(baseUrl, input, plugins, options.pluginRoutes)
    const response = await execute(input, url, method, input.kind === 'management')
    if (input.kind === 'resource' && input.method?.toUpperCase() === 'HEAD') response.body = new Uint8Array()
    return response
  }

  const status = async (): Promise<CpaStatus> => {
    const result: CpaStatus = {
      configured: Boolean(managementKey), connected: false, apiVersion: 'v8', version: null,
      checkedAt: new Date().toISOString(), capabilities: [], error: null,
    }
    try {
      const response = await request({ path: 'config' })
      result.version = response.headers.get('x-cpa-version') || null
      if (response.status < 200 || response.status >= 300) {
        const messages: Record<number, string> = {
          401: 'CPA 管理密钥无效', 403: 'CPA 拒绝管理访问，请检查远程管理设置或临时访问限制',
          404: 'CPA v8 管理接口不可用，请检查版本及管理功能设置',
        }
        result.error = { code: 'upstream_error', message: messages[response.status] || 'CPA 管理接口返回错误', statusCode: response.status }
        return result
      }
      const contentType = response.headers.get('content-type') || ''
      let config: unknown
      try { config = JSON.parse(new TextDecoder().decode(response.body)) } catch { /* A non-CPA service can return 200 HTML. */ }
      if (!contentType.includes('application/json') || !config || typeof config !== 'object' || Array.isArray(config)
        || (config as Record<string, unknown>)['config-version'] !== 8) {
        result.error = { code: 'invalid_response', message: 'CPA v8 管理接口未返回有效配置', statusCode: 502 }
        return result
      }
      result.connected = true
      result.capabilities = ['configuration']
    } catch (error) {
      if (error instanceof CpaClientError) {
        if (error.code === 'invalid_configuration') result.configured = false
        result.error = { code: error.code, message: error.message, statusCode: error.statusCode }
      } else result.error = { code: 'unreachable', message: '无法连接 CPA 内核', statusCode: 502 }
    }
    return result
  }
  return { request, status, pluginRequest, consoleRequest, legacyQuotaRequest, nativePanelRequest }
}
