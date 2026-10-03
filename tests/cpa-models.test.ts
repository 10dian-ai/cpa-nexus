import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import modelsHandler from '../server/api/cpa/models.get'

describe('CPA native model catalog proxy', () => {
  let server: Server | undefined
  let base: string
  let wireFetch: typeof fetch

  beforeEach(async () => {
    wireFetch = globalThis.fetch
    vi.stubEnv('CPA_URL', 'http://cpa.test:8317')
    vi.stubEnv('CPA_CLIENT_KEY', 'native-client-key')
    vi.stubEnv('CPA_MANAGEMENT_KEY', 'private-management-key')
    const app = createApp()
    app.use('/api/cpa/models', modelsHandler)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    vi.restoreAllMocks(); vi.unstubAllEnvs()
  })

  const upstream = (handler: (url: URL | RequestInfo, init?: RequestInit) => Promise<Response>) => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    return String(url).startsWith('http://cpa.test:8317/') ? handler(url, init) : wireFetch(url, init)
  })

  it('uses the native client key and retains the real catalog instead of using management credentials', async () => {
    upstream(async (url, init) => {
      expect(String(url)).toBe('http://cpa.test:8317/v1/models')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer native-client-key')
      expect(init?.redirect).toBe('error')
      return new Response('{"data":[{"id":"native-model"}]}', { headers: { 'content-type': 'application/json' } })
    })
    const response = await fetch(base + '/api/cpa/models')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-nexus-upstream')).toBe('cpa')
    expect(await response.json()).toEqual({ data: [{ id: 'native-model' }] })
  })

  it('preserves upstream authentication status and text without invalidating the platform session', async () => {
    upstream(async () => new Response('invalid native key', { status: 401, headers: { 'content-type': 'text/plain' } }))
    const response = await fetch(base + '/api/cpa/models')
    expect(response.status).toBe(401)
    expect(response.headers.get('x-nexus-upstream')).toBe('cpa')
    expect(await response.text()).toBe('invalid native key')
  })

  it('rejects oversized and broken upstream bodies with controlled errors', async () => {
    upstream(async () => new Response('x', { headers: { 'content-length': String(33 * 1024 * 1024) } }))
    let response = await fetch(base + '/api/cpa/models')
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).toContain('CPA 响应超过允许大小')
    upstream(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private upstream socket detail')) } })))
    response = await fetch(base + '/api/cpa/models')
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain('private upstream socket detail')
  })

  it('times out response bodies that stop delivering data', async () => {
    const timer = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], milliseconds?: number, ...args: any[]) =>
      timer(handler, milliseconds === 8000 ? 20 : milliseconds, ...args)) as typeof setTimeout)
    upstream(async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }))
    const response = await fetch(base + '/api/cpa/models')
    expect(response.status).toBe(504)
    expect(response.headers.get('x-nexus-upstream')).toBe('cpa')
    await response.arrayBuffer()
  })

  it('does not fetch without a client key or with a path-bearing CPA origin', async () => {
    const request = upstream(async () => { throw new Error('must not run') })
    vi.stubEnv('CPA_CLIENT_KEY', '')
    let response = await fetch(base + '/api/cpa/models')
    expect(response.status).toBe(503)
    await response.arrayBuffer()
    vi.stubEnv('CPA_CLIENT_KEY', 'native-client-key'); vi.stubEnv('CPA_URL', 'http://cpa.test:8317/private')
    response = await fetch(base + '/api/cpa/models')
    expect(response.status).toBe(503)
    await response.arrayBuffer()
    expect(request.mock.calls.filter(([url]) => String(url).startsWith('http://cpa.test:8317/'))).toHaveLength(0)
  })
})
