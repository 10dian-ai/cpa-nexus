import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { runInNewContext } from 'node:vm'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
vi.mock('../server/lib/cpa/privacy-hooks', () => ({ applyCpaPrivacyAfterResponse: async () => {} }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ sessions: new Map<string, string>() }))
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({ get: async (key: string) => fixture.sessions.get(key) ?? null }) }))
import { hashGatewayKey } from '../server/lib/crypto'
import adminMiddleware from '../server/middleware/admin'
import consoleHandler from '../server/api/cpa/console/[...path]'
import { CONSOLE_BOOTSTRAP, adaptNativeConsoleHtml, resetNativePanelCache, serveCpaNativePanel } from '../server/lib/cpa/console'
import { createCpaClient } from '../server/lib/cpa/client'

const SESSION = 'test-native-console-session', COOKIE = 'ccm_session=' + SESSION
const MANAGEMENT_KEY = 'test-server-only-management-key', CLIENT_KEY = 'test-server-only-model-key'
const HTML = '<!doctype html><html><head><title>Official fixture</title></head><body><script>window.fixtureLoaded=true</script></body></html>'

describe('complete CPA console through authenticated real local HTTP', () => {
  let upstream: Server, platform: Server, base: string
  let calls: { path: string; method: string; headers: import('node:http').IncomingHttpHeaders; body: string }[]
  let keys: string[]
  beforeEach(async () => {
    calls = []; keys = ['historical-model-key', CLIENT_KEY]; fixture.sessions.clear(); resetNativePanelCache()
    fixture.sessions.set('ccm:admin:session:' + hashGatewayKey(SESSION), 'test-admin')
    upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      calls.push({ path: request.url || '', method: request.method || 'GET', headers: request.headers, body: Buffer.concat(chunks).toString() })
      response.setHeader('x-cpa-version', '8.0.15')
      if (request.url === '/management.html') { response.setHeader('content-type', 'text/html'); response.end(HTML); return }
      if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end('{"data":[{"id":"mock-model"}]}'); return }
      if (request.url === '/v8/management/config/access/api-keys') {
        if (request.method === 'PUT') keys = JSON.parse(Buffer.concat(chunks).toString())
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(request.method === 'GET' ? keys : { status: 'ok' })); return
      }
      const target = new URL(request.url || '/', 'http://core.fixture')
      if (target.pathname === '/v0/management/api-keys') {
        if (request.method === 'PUT') {
          const body = JSON.parse(Buffer.concat(chunks).toString()); keys = Array.isArray(body) ? body : body.items
        } else if (request.method === 'PATCH') {
          const body = JSON.parse(Buffer.concat(chunks).toString())
          if (Number.isInteger(body.index) && body.index >= 0 && body.index < keys.length && typeof body.value === 'string') keys[body.index] = body.value
          else if (typeof body.old === 'string' && typeof body.new === 'string') {
            const index = keys.indexOf(body.old); if (index < 0) keys.push(body.new); else keys[index] = body.new
          } else { response.statusCode = 400 }
        } else if (request.method === 'DELETE') {
          const index = Number.parseInt(target.searchParams.get('index') || '', 10)
          if (Number.isInteger(index) && index >= 0 && index < keys.length) keys.splice(index, 1)
          else if (target.searchParams.get('value')) keys = keys.filter(key => key.trim() !== target.searchParams.get('value')!.trim())
          else response.statusCode = 400
        }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(request.method === 'GET' ? { 'api-keys': keys } : { status: 'ok' })); return
      }
      if (request.url?.startsWith('/v0/resource/plugins/example/page')) {
        response.setHeader('content-type', 'text/html'); response.end('<html><head></head><body><script src="/v0/resource/plugins/example/assets/app.js"></script></body></html>'); return
      }
      if (request.url?.startsWith('/v0/resource/plugins/example/assets/app.js')) {
        response.setHeader('content-type', 'application/javascript'); response.end("const asset='/v0/resource/plugins/example/assets/icon.svg'; fetch('/v0/management/example/status?view=quota')"); return
      }
      if (request.url?.startsWith('/v0/resource/plugins/example/assets/app.css')) {
        response.setHeader('content-type', 'text/css'); response.end("body{background:url('/v0/resource/plugins/example/assets/icon.svg')}"); return
      }
      response.setHeader('content-type', 'application/json'); response.end('{"status":"ok","config-version":8}')
    })
    await new Promise<void>(finish => upstream.listen(0, '127.0.0.1', finish))
    vi.stubEnv('CPA_URL', 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port)
    vi.stubEnv('CPA_MANAGEMENT_KEY', MANAGEMENT_KEY); vi.stubEnv('CPA_CLIENT_KEY', CLIENT_KEY); vi.stubEnv('CPA_PLUGIN_ROUTES', '')
    const router = createRouter().use('/api/cpa/console/**', consoleHandler).get('/native-panel', defineEventHandler(serveCpaNativePanel))
    const app = createApp().use(adminMiddleware).use(router)
    platform = createServer(toNodeListener(app))
    await new Promise<void>(finish => platform.listen(0, '127.0.0.1', finish))
    base = 'http://127.0.0.1:' + (platform.address() as AddressInfo).port
  })
  afterEach(async () => {
    for (const server of [platform, upstream]) if (server) await new Promise<void>(finish => { server.close(() => finish()); server.closeAllConnections() })
    vi.unstubAllEnvs(); resetNativePanelCache()
  })
  const read = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { cookie: COOKIE, authorization: 'Bearer nexus-session', 'x-management-key': 'browser-dummy', ...init.headers } })

  it('requires the actual administrator cookie even when a browser presents the console dummy key', async () => {
    for (const path of ['/native-panel', '/api/cpa/console/v8/management/config', '/api/cpa/console/v0/resource/plugins/example/page']) {
      const result = await fetch(base + path, { headers: { authorization: 'Bearer nexus-session' } })
      expect(result.status).toBe(401); await result.arrayBuffer()
    }
    expect(calls).toHaveLength(0)
  })

  it('replaces browser dummy credentials only in the server-side management header', async () => {
    const result = await read('/api/cpa/console/v8/management/config')
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store')
    const body = await result.text(); expect(body).not.toContain(MANAGEMENT_KEY)
    expect(calls[0]).toMatchObject({ path: '/v8/management/config', headers: { authorization: 'Bearer ' + MANAGEMENT_KEY } })
    expect(calls[0]!.headers.cookie).toBeUndefined(); expect(calls[0]!.headers['x-management-key']).toBeUndefined()
    expect(JSON.stringify(calls[0])).not.toContain('nexus-session')
    expect(JSON.stringify(calls[0])).not.toContain('browser-dummy')
  })

  it('fetches native models using CPA_CLIENT_KEY and keeps native panel asset requests unauthenticated upstream', async () => {
    const models = await read('/api/cpa/console/v1/models')
    expect(await models.json()).toEqual({ data: [{ id: 'mock-model' }] })
    expect(calls[0]!.headers.authorization).toBe('Bearer ' + CLIENT_KEY)
    const first = await read('/native-panel'), second = await read('/native-panel')
    const html = await first.text(); await second.arrayBuffer()
    expect(html).toContain('nexus-cpa-console-bootstrap'); expect(html).toContain("managementKey:'nexus-session'")
    expect(html).not.toContain(MANAGEMENT_KEY); expect(html).not.toContain(CLIENT_KEY)
    const panelCalls = calls.filter(call => call.path === '/management.html')
    expect(panelCalls).toHaveLength(1); expect(panelCalls[0]!.headers.authorization).toBeUndefined()
  })

  it('keeps complete plugin HTML, JavaScript, CSS subpaths and query parameters available without a manual manifest', async () => {
    for (const [path, content] of [
      ['/v0/resource/plugins/example/page?view=quota&auth_index=fixture', 'nexus-cpa-console-bootstrap'],
      ['/v0/resource/plugins/example/assets/app.js?version=1', '/api/cpa/console/v0/resource/plugins/example/assets/icon.svg'],
      ['/v0/resource/plugins/example/assets/app.css?theme=dark', '/api/cpa/console/v0/resource/plugins/example/assets/icon.svg'],
    ]) {
      const response = await read('/api/cpa/console' + path)
      expect(response.status).toBe(200); expect(await response.text()).toContain(content)
      expect(calls.at(-1)!.path).toBe(path); expect(calls.at(-1)!.headers.authorization).toBeUndefined()
    }
    const operation = await read('/api/cpa/console/v0/management/example/status?auth_index=fixture&view=quota')
    expect(operation.status).toBe(200); await operation.arrayBuffer()
    expect(calls.at(-1)).toMatchObject({ path: '/v0/management/example/status?auth_index=fixture&view=quota', headers: { authorization: 'Bearer ' + MANAGEMENT_KEY } })
  })

  it('preserves the reserved model credential when the original console deletes or replaces client keys', async () => {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const result = await read('/api/cpa/console/v8/management/config/access/api-keys', { method,
        ...(method === 'DELETE' ? {} : { body: '["replacement-key"]', headers: { 'content-type': 'application/json' } }) })
      expect(result.status).toBe(200); await result.arrayBuffer()
      expect(calls.at(-1)!.method).toBe('PUT')
      expect(JSON.parse(calls.at(-1)!.body)).toContain(CLIENT_KEY)
      expect(keys).toContain(CLIENT_KEY)
    }
  })

  it('preserves v0 old/new and index/value patch semantics and normal deletion precedence', async () => {
    const patch = async (body: Record<string, unknown>) => {
      const raw = JSON.stringify(body)
      const result = await read('/api/cpa/console/v0/management/api-keys', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: raw })
      expect(result.status).toBe(200); await result.arrayBuffer()
      expect(calls.at(-1)).toMatchObject({ path: '/v0/management/api-keys', method: 'PATCH', body: raw })
    }
    await patch({ old: 'historical-model-key', new: 'renamed-key' })
    expect(keys).toEqual(['renamed-key', CLIENT_KEY])
    // Original v0 gives a valid index/value pair priority over old/new.
    await patch({ index: 0, value: 'indexed-key', old: CLIENT_KEY, new: 'ignored-replacement' })
    expect(keys).toEqual(['indexed-key', CLIENT_KEY])
    const indexedDelete = await read('/api/cpa/console/v0/management/api-keys?index=0&value=' + encodeURIComponent(CLIENT_KEY), { method: 'DELETE' })
    expect(indexedDelete.status).toBe(200); await indexedDelete.arrayBuffer()
    expect(keys).toEqual([CLIENT_KEY])
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v0/management/api-keys?index=0&value=' + encodeURIComponent(CLIENT_KEY) })
    await patch({ old: 'missing-key', new: 'appended-key' })
    expect(keys).toEqual([CLIENT_KEY, 'appended-key'])
    const valueDelete = await read('/api/cpa/console/v0/management/api-keys?value=appended-key', { method: 'DELETE' })
    expect(valueDelete.status).toBe(200); await valueDelete.arrayBuffer()
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v0/management/api-keys?value=appended-key' })
    expect(keys).toEqual([CLIENT_KEY])
  })

  it('blocks reserved v0 key patches and deletes while forwarding no mutating request upstream', async () => {
    for (const [path, method, body] of [
      ['/v0/management/api-keys', 'PATCH', { old: CLIENT_KEY, new: 'replacement' }],
      ['/v0/management/api-keys', 'PATCH', { index: 1, value: 'replacement' }],
      ['/v0/management/api-keys?value=' + encodeURIComponent(CLIENT_KEY), 'DELETE', undefined],
      ['/v0/management/api-keys?index=1&value=historical-model-key', 'DELETE', undefined],
      ['/v0/management/api-keys?index=99&value=' + encodeURIComponent(CLIENT_KEY), 'DELETE', undefined],
    ] as const) {
      const result = await read('/api/cpa/console' + path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) })
      expect(result.status).toBe(409); await result.arrayBuffer()
      expect(keys).toEqual(['historical-model-key', CLIENT_KEY])
    }
    expect(calls.filter(call => call.path.startsWith('/v0/management/api-keys') && call.method !== 'GET')).toHaveLength(0)
  })

  it('accepts original v0 array and items-array replacement bodies while appending the reserved key once', async () => {
    for (const body of [['replacement'], { items: ['replacement'] }, { items: ['replacement', CLIENT_KEY] }]) {
      const result = await read('/api/cpa/console/v0/management/api-keys', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(result.status).toBe(200); await result.arrayBuffer()
      expect(calls.at(-1)).toMatchObject({ path: '/v0/management/api-keys', method: 'PUT' })
      expect(JSON.parse(calls.at(-1)!.body)).toEqual(['replacement', CLIENT_KEY])
      expect(keys).toEqual(['replacement', CLIENT_KEY])
    }
  })

  it('rejects raw traversal before any upstream call and bounds the namespace to the fixed core', async () => {
    for (const path of ['/api/cpa/console/v8/management/%2e%2e/config', '/api/cpa/console/v8/management/%252e%252e/config', '/api/cpa/console/v0/resource/plugins/example/assets%2f..%2fconfig']) {
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        const url = new URL(base)
        const request = httpRequest({ hostname: url.hostname, port: url.port, path, headers: { cookie: COOKIE } }, response => {
          response.resume(); response.once('end', () => resolve({ status: response.statusCode || 0 }))
        })
        request.once('error', reject); request.end()
      })
      expect(result.status).toBe(400)
    }
    const client = createCpaClient({ baseUrl: process.env.CPA_URL, managementKey: MANAGEMENT_KEY })
    for (const path of ['https://untrusted.invalid/config', '//untrusted.invalid/config', 'config/config.yaml', 'v1/chat/completions', 'v0/resource/private/config'])
      await expect(client.consoleRequest({ path })).rejects.toMatchObject({ statusCode: expect.any(Number) })
    expect(calls).toHaveLength(0)
  })

  it('restricts the legacy quota facade to exactly its three official methods and routes', async () => {
    const client = createCpaClient({ baseUrl: process.env.CPA_URL, managementKey: MANAGEMENT_KEY })
    for (const [path, method] of [['quota/providers', 'GET'], ['quota/fetch', 'POST'], ['quota/reset', 'POST']]) {
      expect((await client.legacyQuotaRequest({ path: path!, method, body: method === 'POST' ? '{"auth_index":"fixture"}' : undefined })).status).toBe(200)
      expect(calls.at(-1)!.path).toBe('/v0/management/' + path)
    }
    const count = calls.length
    for (const [path, method] of [['quota/providers', 'POST'], ['quota/fetch', 'GET'], ['quota/reset', 'DELETE'], ['config', 'GET'], ['quota/fetch/extra', 'POST']])
      await expect(Promise.resolve().then(() => client.legacyQuotaRequest({ path: path!, method }))).rejects.toMatchObject({ statusCode: 404 })
    expect(calls).toHaveLength(count)
  })
})

describe('official panel bootstrap behavior in an isolated browser-like runtime', () => {
  it('auto-connects with a non-secret dummy session, namespaces preferences and rewrites only local native routes', async () => {
    class StorageFixture {
      data = new Map<string, string>()
      getItem(name: string) { return this.data.get(name) ?? null }
      setItem(name: string, value: string) { this.data.set(name, value) }
      removeItem(name: string) { this.data.delete(name) }
    }
    const localStorage = new StorageFixture(), sessionStorage = new StorageFixture()
    for (const key of ['cli-proxy-auth', 'apiBase', 'apiUrl', 'managementKey', 'isLoggedIn']) localStorage.setItem(key, 'original:' + key)
    const fetched: unknown[] = [], opened: unknown[][] = []
    class XhrFixture { open(...args: unknown[]) { opened.push(args) } }
    const window = { fetch: async (input: unknown) => { fetched.push(input); return {} } }
    const location = { origin: 'https://nexus.example', href: 'https://nexus.example/native-panel' }
    runInNewContext(CONSOLE_BOOTSTRAP.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''), { Storage: StorageFixture, localStorage, sessionStorage, window, location, URL, Request, XMLHttpRequest: XhrFixture })
    const stored = JSON.parse(localStorage.data.get('nexus:cpa-console:cli-proxy-auth')!)
    expect(stored).toMatchObject({ state: { apiBase: 'https://nexus.example/api/cpa/console', managementKey: 'nexus-session', rememberPassword: true }, version: 0 })
    expect(localStorage.data.get('nexus:cpa-console:isLoggedIn')).toBe('true')
    for (const key of ['cli-proxy-auth', 'apiBase', 'apiUrl', 'managementKey', 'isLoggedIn']) expect(localStorage.data.get(key)).toBe('original:' + key)
    localStorage.setItem('managementKey', 'new-dummy'); expect(localStorage.data.get('managementKey')).toBe('original:managementKey')
    sessionStorage.setItem('managementKey', 'session-value'); expect(sessionStorage.data.get('managementKey')).toBe('session-value')
    await window.fetch('/v8/management/config')
    await window.fetch('https://outside.example/v8/management/config')
    await window.fetch(new Request('https://nexus.example/v0/management/example/quota'))
    expect(fetched[0]).toBe('https://nexus.example/api/cpa/console/v8/management/config')
    expect(fetched[1]).toBe('https://outside.example/v8/management/config')
    expect((fetched[2] as Request).url).toBe('https://nexus.example/api/cpa/console/v0/management/example/quota')
    new XhrFixture().open('GET', '/v0/resource/plugins/example/assets/app.js')
    expect(opened[0]![1]).toBe('https://nexus.example/api/cpa/console/v0/resource/plugins/example/assets/app.js')
  })
  it('rejects invalid HTML before injecting an unusable or secret-bearing panel', () => {
    expect(() => adaptNativeConsoleHtml(Buffer.from('{"error":"not-html"}'))).toThrow()
    const html = new TextDecoder().decode(adaptNativeConsoleHtml(Buffer.from(HTML)))
    expect(html.indexOf('nexus-cpa-console-bootstrap')).toBeLessThan(html.indexOf('window.fixtureLoaded'))
    expect(html).not.toContain(MANAGEMENT_KEY)
  })
})
