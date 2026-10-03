import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/lib/redis', () => ({
  getRedis: () => ({ get: async () => 'admin' }),
}))

import adminMiddleware from '../server/middleware/admin'
import statusHandler from '../server/api/cpa/status.get'
import managementHandler from '../server/api/cpa/management/[...path]'
import resourceHandler from '../server/api/cpa/resources/[...path]'
import pluginManagementHandler from '../server/api/cpa/plugin-management/[...path]'

const COOKIE = 'ccm_session=test-session'
const ADMIN_HEADERS = { cookie: COOKIE }

describe('CPA management integration over real authenticated HTTP', () => {
  let upstream: Server | undefined
  let platform: Server | undefined
  let base: string
  let calls: { path: string; headers: import('node:http').IncomingHttpHeaders; body: Buffer }[]
  let stallApiCall: boolean
  let stalledResponse: ServerResponse | undefined

  beforeEach(async () => {
    calls = []
    stallApiCall = false; stalledResponse = undefined
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      calls.push({ path: req.url || '', headers: req.headers, body: Buffer.concat(chunks) })
      res.setHeader('X-CPA-VERSION', 'v8.0.11')
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v8/management/config') res.end('{"config-version":8}')
      else if (req.url === '/v8/management/plugins') res.end(JSON.stringify({ plugins: [{ id: 'example', effective_enabled: true, menus: [{ path: '/v0/resource/plugins/example/status' }] }] }))
      else if (req.url?.startsWith('/v8/management/credentials/download')) {
        res.setHeader('content-type', 'application/octet-stream')
        res.setHeader('content-disposition', 'attachment; filename=auth.json')
        res.end(Buffer.from([0, 255, 128, 10]))
      } else if (req.url === '/v8/management/credentials/status') {
        res.statusCode = 422
        res.end('{"error":"invalid_body"}')
      } else if (req.url === '/v0/resource/plugins/example/status') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<html>Declared plugin page</html>')
      } else if (req.url === '/v0/management/example/refresh') res.end('{"refreshed":true}')
      else if (req.url === '/v8/management/requests/api-call') {
        if (stallApiCall) { stalledResponse = res; return }
        res.end('{"status_code":418,"header":{"Content-Type":["text/plain"]},"body":"upstream probe response"}')
      }
      else if (req.url === '/v8/management/oauth/import?provider=vertex') res.end('{"status":"ok","project_id":"test-project","email":"test@example.invalid"}')
      else res.end('{"status":"ok"}')
    })
    await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('CPA_URL', `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`)
    vi.stubEnv('CPA_MANAGEMENT_KEY', 'private-server-key')
    vi.stubEnv('CPA_PLUGIN_ROUTES', '[{"pluginId":"example","kind":"management","path":"/v0/management/example/refresh","methods":["POST"]}]')
    const app = createApp()
    app.use(adminMiddleware)
    const router = createRouter()
    router.get('/api/cpa/status', statusHandler)
    router.use('/api/cpa/management/**', managementHandler)
    router.use('/api/cpa/resources/**', resourceHandler)
    router.use('/api/cpa/plugin-management/**', pluginManagementHandler)
    app.use(router)
    platform = createServer(toNodeListener(app))
    await new Promise<void>(resolve => platform!.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    for (const server of [platform, upstream]) if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    vi.unstubAllEnvs()
  })

  it('protects status, management and plugin routes with the existing administrator middleware', async () => {
    for (const path of ['/api/cpa/status', '/api/cpa/management/config', '/api/cpa/resources/example/status', '/api/cpa/plugin-management/example/refresh']) {
      const response = await fetch(base + path)
      expect(response.status).toBe(401)
      await response.arrayBuffer()
    }
    expect(calls).toEqual([])
  })

  it('returns truthful connection status without exposing the server management key', async () => {
    const response = await fetch(base + '/api/cpa/status', { headers: ADMIN_HEADERS })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ connected: true, configured: true, version: 'v8.0.11' })
    expect(JSON.stringify(result)).not.toContain('private-server-key')
    expect(calls[0]!.headers.authorization).toBe('Bearer private-server-key')
    expect(calls[0]!.headers.cookie).toBeUndefined()
  })

  it('forwards original request bytes and preserves upstream validation failure', async () => {
    const body = '{ "name": "auth.json", "disabled": true }'
    const response = await fetch(base + '/api/cpa/management/credentials/status', {
      method: 'PATCH', headers: { ...ADMIN_HEADERS, 'content-type': 'application/json', authorization: 'Bearer browser-key' }, body,
    })
    expect(response.status).toBe(422)
    expect(response.headers.get('x-nexus-upstream')).toBe('cpa')
    expect(await response.json()).toEqual({ error: 'invalid_body' })
    expect(calls[0]!.body.toString()).toBe(body)
    expect(calls[0]!.headers.authorization).toBe('Bearer private-server-key')
  })

  it('preserves binary downloads and multipart upload bodies', async () => {
    const download = await fetch(base + '/api/cpa/management/credentials/download?name=auth.json', { headers: ADMIN_HEADERS })
    expect(download.headers.get('content-type')).toBe('application/octet-stream')
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([0, 255, 128, 10])
    const boundary = 'test-cpa-boundary'
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="auth.json"\r\nContent-Type: application/json\r\n\r\n{"type":"codex"}\r\n--${boundary}--\r\n`
    const upload = await fetch(base + '/api/cpa/management/credentials', {
      method: 'POST', headers: { ...ADMIN_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
    })
    expect(upload.status).toBe(200)
    await upload.arrayBuffer()
    expect(calls[1]!.body.toString()).toBe(body)
    expect(calls[1]!.headers['content-type']).toContain(boundary)
  })

  it('rejects cross-origin mutations before contacting CPA', async () => {
    const response = await fetch(base + '/api/cpa/management/config', {
      method: 'PATCH', headers: { ...ADMIN_HEADERS, origin: 'https://another.example', 'content-type': 'application/json' }, body: '{}',
    })
    expect(response.status).toBe(403)
    await response.arrayBuffer()
    expect(calls).toEqual([])
  })

  it('returns declared plugin HTML and manifest APIs through authenticated local routes', async () => {
    const resource = await fetch(base + '/api/cpa/resources/example/status', { headers: ADMIN_HEADERS })
    expect(resource.status).toBe(200)
    expect(resource.headers.get('content-type')).toContain('text/html')
    expect(await resource.text()).toContain('Declared plugin page')
    const management = await fetch(base + '/api/cpa/plugin-management/example/refresh', { method: 'POST', headers: ADMIN_HEADERS })
    expect(management.status).toBe(200)
    expect(await management.json()).toEqual({ refreshed: true })
    expect(calls.filter(call => call.path === '/v8/management/plugins')).toHaveLength(2)
  })

  it('reports an unconfigured core without breaking existing platform authentication', async () => {
    vi.stubEnv('CPA_MANAGEMENT_KEY', '')
    const status = await fetch(base + '/api/cpa/status', { headers: ADMIN_HEADERS })
    expect(await status.json()).toMatchObject({ configured: false, connected: false })
    const response = await fetch(base + '/api/cpa/management/config', { headers: ADMIN_HEADERS })
    expect(response.status).toBe(503)
    expect(response.headers.get('x-nexus-upstream')).toBe('cpa')
    await response.arrayBuffer()
    expect(calls).toEqual([])
  })

  it('forwards the approved native API probe body to CPA and preserves its nested upstream response', async () => {
    const payload = {
      method: 'GET', url: 'https://probe.example.invalid/test', auth_index: 'test-account',
      header: { Authorization: 'Bearer $TOKEN$' },
    }
    const response = await fetch(base + '/api/cpa/management/requests/api-call', {
      method: 'POST', headers: { ...ADMIN_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status_code: 418, header: { 'Content-Type': ['text/plain'] }, body: 'upstream probe response' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/v8/management/requests/api-call')
    expect(JSON.parse(calls[0]!.body.toString())).toEqual(payload)
    expect(calls[0]!.headers.authorization).toBe('Bearer private-server-key')
  })

  it('preserves Vertex service-account multipart and location through the authenticated native import proxy', async () => {
    const form = new FormData()
    form.set('file', new Blob(['{"type":"service_account","project_id":"test-project"}'], { type: 'application/json' }), 'vertex-test.json')
    form.set('location', 'us-central1')
    const response = await fetch(base + '/api/cpa/management/oauth/import?provider=vertex', {
      method: 'POST', headers: ADMIN_HEADERS, body: form,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', project_id: 'test-project' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/v8/management/oauth/import?provider=vertex')
    expect(calls[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    const wire = calls[0]!.body.toString()
    expect(wire).toContain('filename="vertex-test.json"')
    expect(wire).toContain('"project_id":"test-project"')
    expect(wire).toContain('name="location"')
    expect(wire).toContain('us-central1')
    expect(calls[0]!.headers.authorization).toBe('Bearer private-server-key')
  })

  it('cancels an in-progress long CPA operation when the browser disconnects', async () => {
    stallApiCall = true
    const controller = new AbortController()
    const pending = fetch(base + '/api/cpa/management/requests/api-call', {
      method: 'POST', signal: controller.signal, headers: { ...ADMIN_HEADERS, 'content-type': 'application/json' },
      body: '{"method":"GET","url":"https://probe.example.invalid/test"}',
    }).catch(error => error)
    await vi.waitFor(() => expect(stalledResponse).toBeDefined())
    controller.abort()
    const result = await pending
    expect(result.name).toBe('AbortError')
    await vi.waitFor(() => expect(stalledResponse?.destroyed).toBe(true), { timeout: 1500 })
  })
})
