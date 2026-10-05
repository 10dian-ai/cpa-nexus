import { describe, expect, it, vi } from 'vitest'
import { CpaClientError, cpaRequestTimeoutMs, createCpaClient, resolveCpaManagementRequest, validateCpaBaseUrl } from '../server/lib/cpa/client'

const KEY = 'server-management-secret'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
})

describe('CPA management route contract', () => {
  it('limits the native Nexus adapter to its exact discovery and group-policy methods', () => {
    expect(resolveCpaManagementRequest('http://cpa:8317', { path: 'nexus/capabilities' }).url.pathname).toBe('/v8/management/nexus/capabilities')
    expect(resolveCpaManagementRequest('http://cpa:8317', { path: 'nexus/group-policies', method: 'POST' }).method).toBe('POST')
    expect(() => resolveCpaManagementRequest('http://cpa:8317', { path: 'nexus/group-policies', method: 'GET' })).toThrow(expect.objectContaining({ code: 'unsupported_method' }))
    expect(() => resolveCpaManagementRequest('http://cpa:8317', { path: 'nexus/anything' })).toThrow(expect.objectContaining({ code: 'unsupported_path' }))
  })
  it('builds requests only under the configured v8 management origin and encodes query values', () => {
    const result = resolveCpaManagementRequest('http://cpa:8317', {
      path: 'credentials/download', query: { name: 'user+test@example.com.json' },
    })
    expect(result.url.origin).toBe('http://cpa:8317')
    expect(result.url.pathname).toBe('/v8/management/credentials/download')
    expect(result.url.searchParams.get('name')).toBe('user+test@example.com.json')
    expect(resolveCpaManagementRequest('https://example.com/', { path: 'config/plugins/configs/my-plugin/enabled', method: 'PUT' }).method).toBe('PUT')
  })

  it.each([
    '/config', '//evil.example/config', 'https://evil.example/config', '../config',
    'config/../../credentials', 'config/%2e%2e/access', 'config/%252e%252e/access',
    'config/a%2fb', 'config/a%5Cb', 'config/a\\b', 'config//access',
    'config?url=https://evil.example', 'config#fragment', 'config/%00', 'config/%ZZ',
  ])('rejects ambiguous, absolute and traversal paths: %s', path => {
    expect(() => resolveCpaManagementRequest('http://cpa:8317', { path })).toThrow(CpaClientError)
  })

  it.each(['ftp://cpa', 'file:///tmp/config', 'http://user:secret@cpa:8317', 'http://cpa:8317/v8/management', 'http://cpa:8317?url=x', 'not-a-url'])('rejects invalid base URL: %s', value => {
    expect(() => validateCpaBaseUrl(value)).toThrow(CpaClientError)
  })

  it('rejects unknown routes, methods, query parameters and duplicate parameters', () => {
    expect(() => resolveCpaManagementRequest('http://cpa:8317', { path: 'shutdown' })).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => resolveCpaManagementRequest('http://cpa:8317', { path: 'config.yaml', method: 'PATCH' })).toThrow(expect.objectContaining({ statusCode: 405 }))
    expect(() => resolveCpaManagementRequest('http://cpa:8317', { path: 'credentials', query: { url: 'https://evil.example' } })).toThrow(expect.objectContaining({ code: 'invalid_query' }))
    expect(() => resolveCpaManagementRequest('http://cpa:8317', { path: 'credentials', query: new URLSearchParams('name=a&name=b') })).toThrow(expect.objectContaining({ code: 'invalid_query' }))
  })

  it.each([
    ['config', 'PATCH'], ['config.yaml', 'PUT'], ['config/access/api-keys', 'DELETE'], ['config/upstream/openai', 'PATCH'], ['config/observability/logs/request-log', 'GET'], ['config/observability/logs/request-log', 'PUT'],
    ['credentials', 'POST'], ['credentials/status', 'PATCH'], ['credentials/fields', 'PATCH'], ['credentials/refresh', 'POST'],
    ['oauth/auth-url', 'GET'], ['oauth/status', 'GET'], ['oauth/session', 'DELETE'], ['oauth/import', 'POST'], ['oauth/callback', 'POST'],
    ['plugins/store/test/install', 'POST'], ['plugins/test/quota', 'DELETE'], ['plugins/test', 'DELETE'],
    ['routing/model-definitions/codex', 'GET'], ['routing/cooldown/reset', 'POST'],
    ['observability/logs/errors/error-2026.log', 'GET'], ['observability/logs/requests/test', 'GET'],
    ['observability/usage/queue', 'GET'], ['observability/usage/api-keys', 'GET'], ['requests/api-call', 'POST'], ['server/latest-version', 'GET'],
  ])('supports the official route %s %s', (path, method) => {
    expect(resolveCpaManagementRequest('http://cpa:8317', { path, method }).url.pathname).toBe('/v8/management/' + path)
  })
})

describe('CPA server-side management transport', () => {
  it('gives known long POST operations 120 seconds while reads and configuration remain at 15 seconds', () => {
    for (const path of ['credentials/refresh', 'requests/api-call', 'plugins/store/example/install']) {
      expect(cpaRequestTimeoutMs({ path, method: 'POST' })).toBe(120_000)
    }
    for (const [path, method] of [['config', 'GET'], ['config', 'PUT'], ['plugins/store', 'GET'], ['credentials', 'POST'], ['credentials/refresh', 'GET']]) {
      expect(cpaRequestTimeoutMs({ path: path!, method })).toBe(15_000)
    }
  })

  it('allows a delayed long operation beyond the normal read timeout using injectable deadlines', async () => {
    const fetcher = vi.fn(async (_url: URL | RequestInfo, options?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(json({ status: 'ok' })), 35)
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    }))
    const client = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: fetcher, timeoutMs: 10, longOperationTimeoutMs: 100 })
    expect((await client.request({ path: 'credentials/refresh', method: 'POST', body: '{"all":true}' })).status).toBe(200)
    await expect(client.request({ path: 'config' })).rejects.toMatchObject({ code: 'timeout', statusCode: 504 })
  })

  it('cancels a long operation promptly and shares the cancellation signal with upstream fetch', async () => {
    let upstreamSignal: AbortSignal | undefined
    const controller = new AbortController()
    const fetcher = vi.fn((_url: URL | RequestInfo, options?: RequestInit) => {
      upstreamSignal = options?.signal || undefined
      return new Promise<Response>(() => {})
    })
    const client = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: fetcher, longOperationTimeoutMs: 1000 })
    const pending = client.request({ path: 'requests/api-call', method: 'POST', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', statusCode: 499 })
    expect(upstreamSignal?.aborted).toBe(true)
  })

  it('uses only the server key and strips browser credentials, cookies, proxy headers and response cookies', async () => {
    const fetcher = vi.fn(async () => json({ ok: true }, 200, { 'set-cookie': 'upstream=secret', 'x-cpa-version': 'v8.0.11' }))
    const client = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: fetcher })
    const response = await client.request({
      path: 'config/access/api-keys', method: 'PUT', body: '["client-key"]',
      headers: { authorization: 'Bearer browser-key', cookie: 'ccm_session=private', 'x-management-key': 'browser-key', 'x-forwarded-for': '1.2.3.4', 'content-type': 'application/json' },
    })
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.href).toBe('http://cpa:8317/v8/management/config/access/api-keys')
    const headers = new Headers(options.headers)
    expect(headers.get('authorization')).toBe('Bearer ' + KEY)
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('x-management-key')).toBeNull()
    expect(headers.get('x-forwarded-for')).toBeNull()
    expect(options.body).toBe('["client-key"]')
    expect(options.redirect).toBe('manual')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-cpa-version')).toBe('v8.0.11')
    expect(response.headers.get('x-nexus-upstream')).toBe('cpa')
  })

  it('preserves upstream status and error JSON instead of converting it into a successful response', async () => {
    const response = await createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: async () => json({ error: 'invalid_config', message: 'bad routing' }, 422) }).request({ path: 'config', method: 'PUT', body: '{}' })
    expect(response.status).toBe(422)
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ error: 'invalid_config', message: 'bad routing' })
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it('preserves binary downloads, text YAML and multipart upload bodies', async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10])
    const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=auth.json' } }))
    const client = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: fetcher })
    const download = await client.request({ path: 'credentials/download', query: { name: 'auth.json' } })
    expect([...download.body]).toEqual([...bytes])
    expect(download.headers.get('content-disposition')).toContain('auth.json')
    const multipart = new FormData()
    multipart.set('file', new Blob(['{"type":"codex"}'], { type: 'application/json' }), 'auth.json')
    await client.request({ path: 'credentials', method: 'POST', body: multipart })
    expect((fetcher.mock.calls[1] as unknown as [URL, RequestInit])[1].body).toBe(multipart)
    const yaml = 'config-version: 8\nrequests:\n  proxy-url: direct\n'
    const yamlResponse = await createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: async () => new Response(yaml, { headers: { 'content-type': 'application/yaml' } }) }).request({ path: 'config.yaml' })
    expect(new TextDecoder().decode(yamlResponse.body)).toBe(yaml)
    expect(yamlResponse.headers.get('content-type')).toBe('application/yaml')
  })

  it('bounds both connection waiting and response body waiting', async () => {
    const connection = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, timeoutMs: 15, fetch: () => new Promise(() => {}) })
    await expect(connection.request({ path: 'config' })).rejects.toMatchObject({ code: 'timeout', statusCode: 504 })
    const body = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, timeoutMs: 15, fetch: async () => new Response(new ReadableStream({ start() {} })) })
    await expect(body.request({ path: 'config' })).rejects.toMatchObject({ code: 'timeout', statusCode: 504 })
  })

  it('limits declared and streamed response sizes and does not leak network errors', async () => {
    const oversized = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, maxResponseBytes: 2, fetch: async () => new Response('large') })
    await expect(oversized.request({ path: 'config' })).rejects.toMatchObject({ code: 'response_too_large' })
    const declared = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, maxResponseBytes: 2, fetch: async () => new Response('a', { headers: { 'content-length': '100' } }) })
    await expect(declared.request({ path: 'config' })).rejects.toMatchObject({ code: 'response_too_large' })
    const unavailable = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: async () => { throw new Error(KEY + ' internal database address') } })
    await expect(unavailable.request({ path: 'config' })).rejects.toMatchObject({ message: '无法连接 CPA 内核' })
  })

  it('does not disclose the configured server key even if an upstream echoes it', async () => {
    const client = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: async () => json({ authorization: 'Bearer ' + KEY }) })
    await expect(client.request({ path: 'config' })).rejects.toMatchObject({ code: 'sensitive_response', statusCode: 502 })
  })

  it('reports missing configuration without making any upstream request', async () => {
    const fetcher = vi.fn()
    const client = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: '', fetch: fetcher })
    expect(await client.status()).toMatchObject({ configured: false, connected: false, version: null, capabilities: [], error: { code: 'not_configured' } })
    await expect(client.request({ path: 'config' })).rejects.toMatchObject({ statusCode: 503 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports installed version only from CPA response headers and only verified capabilities', async () => {
    const fetcher = vi.fn(async () => json({ 'config-version': 8, port: 8317 }, 200, { 'x-cpa-version': 'v8.0.11' }))
    const status = await createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: fetcher }).status()
    expect(status).toMatchObject({ configured: true, connected: true, version: 'v8.0.11', capabilities: ['configuration'], error: null })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((fetcher.mock.calls[0] as unknown as [URL])[0].pathname).toBe('/v8/management/config')
  })

  it('does not claim to be connected for HTML, invalid JSON or authentication failure', async () => {
    for (const response of [new Response('<html>login</html>'), json([], 200), json({ ok: true }, 200), json({ error: 'invalid management key' }, 401), json({ error: 'not_found' }, 404)]) {
      const status = await createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: KEY, fetch: async () => response }).status()
      expect(status.connected).toBe(false)
      expect(status.capabilities).toEqual([])
      expect(status.error).not.toBeNull()
      expect(JSON.stringify(status)).not.toContain(KEY)
    }
  })
})
