import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createError, defineEventHandler, getHeader, toNodeListener, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ expired: false, privacy: vi.fn() }))
vi.mock('../server/lib/auth', () => ({
  requireAdmin: async (event: H3Event) => { if (fixture.expired || getHeader(event, 'cookie') !== 'session=local-admin-test') throw createError({ statusCode: 401, message: '需要登录' }) },
  requireServiceKey: async () => { throw createError({ statusCode: 401 }) },
}))
vi.mock('../server/lib/cpa/privacy-hooks', () => ({ applyCpaPrivacyAfterResponse: fixture.privacy }))
import adminMiddleware from '../server/middleware/admin'
import { proxyCpaPlugin } from '../server/lib/cpa/http'
import { proxyCpaConsole } from '../server/lib/cpa/console'

describe('plugin compatibility through the existing authenticated core scope', () => {
  let core: Server, app: Server, appUrl: string, coreUrl: string
  const calls: { path: string; method: string; authorization: string | undefined; cookie: string | undefined; body: string }[] = []
  const management = 'local-management-test-credential', reserved = 'local-client-test-credential'
  const discovery = { plugins_enabled: true, plugins: [{ id: 'usage-report', enabled: true, registered: true, effective_enabled: true,
    menus: [{ path: '/v0/resource/plugins/usage-report/index.html', menu: 'Usage' }] }] }
  const listen = async (server: Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + (server.address() as AddressInfo).port }
  beforeEach(async () => {
    fixture.expired = false; calls.length = 0; fixture.privacy.mockReset()
    core = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk
      calls.push({ path: request.url!, method: request.method!, authorization: request.headers.authorization, cookie: request.headers.cookie, body })
      const url = new URL(request.url!, 'http://local-core.invalid')
      response.setHeader('content-type', 'application/json')
      if (url.pathname === '/v8/management/plugins') return void response.end(JSON.stringify(discovery))
      if (url.pathname === '/v8/management/config/access/api-keys') return void response.end(JSON.stringify([reserved, 'other-client-key']))
      if (url.pathname === '/v0/resource/plugins/usage-report/index.html') {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        return void response.end('<html><head></head><body><script src="/v0/resource/plugins/usage-report/assets/app.js?lang=zh-CN"></script></body></html>')
      }
      if (url.pathname === '/v0/resource/plugins/usage-report/assets/app.js') {
        response.setHeader('content-type', 'text/javascript; charset=utf-8')
        return void response.end('fetch("/v0/management/usage-report/query?group=A&group=B")')
      }
      if (url.pathname === '/v0/resource/plugins/usage-report/assets/app.css') {
        response.setHeader('content-type', 'text/css')
        return void response.end('body{background:url("/v0/resource/plugins/usage-report/assets/icon.svg")}')
      }
      if (url.pathname === '/v0/resource/plugins/usage-report/assets/icon.svg') {
        response.setHeader('content-type', 'image/svg+xml')
        return void response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')
      }
      if (url.pathname === '/v0/management/usage-report/query' || url.pathname === '/v0/management/api-keys' || url.pathname === '/v0/management/plugins/store/sample/install') return void response.end('{"status":"ok"}')
      response.statusCode = 404; response.end('{"error":"unregistered_route"}')
    })
    coreUrl = await listen(core); vi.stubEnv('CPA_URL', coreUrl); vi.stubEnv('CPA_MANAGEMENT_KEY', management); vi.stubEnv('CPA_CLIENT_KEY', reserved); vi.stubEnv('CPA_PLUGIN_ROUTES', '')
    const h3 = createApp(); h3.use(adminMiddleware)
    h3.use(defineEventHandler(event => event.node.req.url?.startsWith('/api/cpa/resources/') ? proxyCpaPlugin(event, 'resource')
      : event.node.req.url?.startsWith('/api/cpa/plugin-management/') ? proxyCpaPlugin(event, 'management') : proxyCpaConsole(event)))
    app = createServer(toNodeListener(h3)); appUrl = await listen(app)
  })
  afterEach(async () => { for (const server of [app, core]) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }); vi.unstubAllEnvs() })
  const request = (path: string, options: RequestInit = {}) => fetch(appUrl + path, { ...options, headers: { cookie: 'session=local-admin-test', ...(options.method && options.method !== 'GET' ? { origin: appUrl } : {}), ...options.headers } })
  it('reads the native plugin asset namespace and preserves supported asset queries without contacting another host', async () => {
    const html = await request('/api/cpa/console/v0/resource/plugins/usage-report/index.html')
    const page = await html.text()
    expect(page).toContain('nexus-cpa-console-bootstrap')
    expect(page).toContain('nexus-session')
    expect(page).not.toContain(management)
    expect(page).not.toContain(reserved)
    const response = await request('/api/cpa/console/v0/resource/plugins/usage-report/assets/app.js?lang=zh-CN&group=A&group=B')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('/v0/management/usage-report/query')
    const asset = calls.find(call => call.path.includes('/assets/app.js'))!
    expect(asset.path).toBe('/v0/resource/plugins/usage-report/assets/app.js?lang=zh-CN&group=A&group=B')
    expect(asset.authorization).toBeUndefined(); expect(asset.cookie).toBeUndefined()
    expect((await request('/api/cpa/console/v0/resource/plugins/absent-plugin/assets/app.js')).status).toBe(404)
    expect(calls.find(call => call.path.includes('absent-plugin'))?.authorization).toBeUndefined()
    const css = await request('/api/cpa/console/v0/resource/plugins/usage-report/assets/app.css')
    expect(await css.text()).toContain('/api/cpa/console/v0/resource/plugins/usage-report/assets/icon.svg')
    const image = await request('/api/cpa/console/v0/resource/plugins/usage-report/assets/icon.svg')
    expect(image.headers.get('content-type')).toContain('image/svg+xml')
    expect(await image.text()).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')
  })
  it('delegates declared plugin management and store operations to the same native core scope and mutation hook', async () => {
    const body = '{"filters":{"groups":["A","B"]}}'
    expect((await request('/api/cpa/console/v0/management/usage-report/query?group=A&group=B', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(200)
    expect(calls.find(call => call.path.startsWith('/v0/management/usage-report/query'))).toMatchObject({ authorization: 'Bearer ' + management, cookie: undefined, body })
    expect(fixture.privacy).toHaveBeenCalledWith('v0/management/usage-report/query', 'POST', expect.anything())
    const install = await request('/api/cpa/console/v0/management/plugins/store/sample/install?source=official&version=1.2.3', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"version":"1.2.3"}' })
    expect(install.status).toBe(200)
    expect(calls.some(call => call.path === '/v0/management/plugins/store/sample/install?source=official&version=1.2.3')).toBe(true)
  })
  it('keeps the reserved internal client key through the native plugin scope and refuses removing it', async () => {
    expect((await request('/api/cpa/console/v0/management/api-keys', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '["new-client-key"]' })).status).toBe(200)
    expect(JSON.parse(calls.find(call => call.path === '/v0/management/api-keys')!.body)).toEqual(['new-client-key', reserved])
    const before = calls.filter(call => call.path.startsWith('/v0/management/api-keys')).length
    expect((await request('/api/cpa/console/v0/management/api-keys?value=' + reserved, { method: 'DELETE' })).status).toBe(409)
    expect(calls.filter(call => call.path.startsWith('/v0/management/api-keys'))).toHaveLength(before)
  })
  it('requires the existing admin session and origin policy for both native management and plugin resources', async () => {
    for (const prefix of ['/api/cpa/console/v0/resource/plugins/usage-report/', '/api/cpa/console/v0/management/']) {
      expect((await fetch(appUrl + prefix + 'usage-report/query')).status).toBe(401)
      expect((await request(prefix + 'usage-report/query', { method: 'POST', headers: { origin: 'https://external.invalid' }, body: '{}' })).status).toBe(403)
      fixture.expired = true
      expect((await request(prefix + 'usage-report/query')).status).toBe(401)
      fixture.expired = false
    }
    expect(calls).toEqual([])
  })
  it.each(['/api/cpa/console/v0/resource/plugins/usage-report/%2e%2e/config', '/api/cpa/console/v0/management/usage-report/%252fconfig', '/api/cpa/console/v0/management/https%3A%2F%2Foutside.invalid/path'])(
    'rejects traversal or alternate destinations before contacting the core: %s', async path => {
      const response = await new Promise<{ status: number }>((resolve, reject) => {
        const raw = httpRequest(appUrl, { path, headers: { cookie: 'session=local-admin-test' } }, reply => { reply.resume(); reply.on('end', () => resolve({ status: reply.statusCode! })) })
        raw.on('error', reject); raw.end()
      })
      expect(response.status).toBe(400)
      expect(calls.every(call => call.path === '/v8/management/plugins')).toBe(true)
    })
})
