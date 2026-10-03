import { describe, expect, it, vi } from 'vitest'
import { createCpaClient } from '../server/lib/cpa/client'
import { parseCpaPluginRoutes, resolveCpaPluginRequest, type CpaPluginRoute } from '../server/lib/cpa/plugins'
import { adaptCpaResourceBody } from '../server/lib/cpa/http'

const discovery = {
  plugins_enabled: true,
  plugins: [{ id: 'example', effective_enabled: true, menus: [{ path: '/v0/resource/plugins/example/status', menu: 'Status' }] }],
}
const manifest: CpaPluginRoute[] = [
  { pluginId: 'example', kind: 'management', path: '/v0/management/example/refresh', methods: ['POST'], query: ['auth_index'] },
  { pluginId: 'example', kind: 'resource', path: '/v0/resource/plugins/example/assets/logo.png', methods: ['GET', 'HEAD'], query: ['v'] },
]

describe('CPA plugin discovery and trusted route manifest', () => {
  it('exposes only exact menu resources declared by an enabled plugin', () => {
    expect(resolveCpaPluginRequest('http://cpa:8317', { kind: 'resource', path: 'example/status' }, discovery, []).url.pathname).toBe('/v0/resource/plugins/example/status')
    expect(() => resolveCpaPluginRequest('http://cpa:8317', { kind: 'resource', path: 'example/status/other' }, discovery, [])).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => resolveCpaPluginRequest('http://cpa:8317', { kind: 'resource', path: 'another/status' }, discovery, [])).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => resolveCpaPluginRequest('http://cpa:8317', { kind: 'resource', path: 'example/status', method: 'POST' }, discovery, [])).toThrow(expect.objectContaining({ statusCode: 405 }))
  })

  it('supports exact server-declared assets and dynamic management routes with declared methods and query keys', () => {
    const result = resolveCpaPluginRequest('http://cpa:8317', { kind: 'management', path: 'example/refresh', method: 'POST', query: { auth_index: 'account-1' } }, discovery, manifest)
    expect(result.url.pathname).toBe('/v0/management/example/refresh')
    expect(result.url.searchParams.get('auth_index')).toBe('account-1')
    expect(resolveCpaPluginRequest('http://cpa:8317', { kind: 'resource', path: 'example/assets/logo.png', method: 'HEAD', query: { v: 1 } }, discovery, manifest).method).toBe('GET')
    expect(() => resolveCpaPluginRequest('http://cpa:8317', { kind: 'management', path: 'example/refresh', method: 'DELETE' }, discovery, manifest)).toThrow(expect.objectContaining({ statusCode: 405 }))
    expect(() => resolveCpaPluginRequest('http://cpa:8317', { kind: 'management', path: 'example/refresh', method: 'POST', query: { url: 'https://evil.example' } }, discovery, manifest)).toThrow(expect.objectContaining({ code: 'invalid_query' }))
  })

  it('does not route a configured manifest to a disabled or missing plugin', () => {
    for (const response of [{ plugins: [] }, { plugins: [{ id: 'example', effective_enabled: false, menus: discovery.plugins[0]!.menus }] }]) {
      expect(() => resolveCpaPluginRequest('http://cpa:8317', { kind: 'management', path: 'example/refresh', method: 'POST' }, response, manifest)).toThrow(expect.objectContaining({ statusCode: 404 }))
      expect(() => resolveCpaPluginRequest('http://cpa:8317', { kind: 'resource', path: 'example/status' }, response, manifest)).toThrow(expect.objectContaining({ statusCode: 404 }))
    }
  })

  it.each([
    'not JSON', '{}', '[{"pluginId":"example","kind":"resource","path":"/v0/resource/plugins/another/asset","methods":["GET"]}]',
    '[{"pluginId":"example","kind":"management","path":"/v0/management/example/*","methods":["POST"]}]',
    '[{"pluginId":"example","kind":"management","path":"/v0/management/example/../config","methods":["GET"]}]',
    '[{"pluginId":"example","kind":"management","path":"https://evil.example/api","methods":["GET"]}]',
    '[{"pluginId":"example","kind":"resource","path":"/v0/resource/plugins/example/write","methods":["POST"]}]',
  ])('rejects invalid and non-exact manifest entries: %s', value => {
    expect(() => parseCpaPluginRoutes(value)).toThrow(expect.objectContaining({ code: 'invalid_configuration', statusCode: 503 }))
  })

  it('fetches live plugin discovery before a resource and authenticates with the server key only', async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(String(url).endsWith('/plugins') ? 'Bearer server-secret' : null)
      return String(url).endsWith('/plugins')
        ? new Response(JSON.stringify(discovery), { headers: { 'content-type': 'application/json' } })
        : new Response('<html>Plugin status</html>', { headers: { 'content-type': 'text/html' } })
    })
    const response = await createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: 'server-secret', fetch: fetcher, pluginRoutes: [] }).pluginRequest({ kind: 'resource', path: 'example/status' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://cpa:8317/v8/management/plugins')
    expect(String(fetcher.mock.calls[1]![0])).toBe('http://cpa:8317/v0/resource/plugins/example/status')
    expect(new TextDecoder().decode(response.body)).toBe('<html>Plugin status</html>')
    expect(response.headers.get('content-type')).toBe('text/html')
  })

  it('preserves CPA auth failure without contacting a plugin, and does not fetch undeclared routes', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"invalid management key"}', { status: 401, headers: { 'content-type': 'application/json' } }))
    const client = createCpaClient({ baseUrl: 'http://cpa:8317', managementKey: 'server-secret', fetch: fetcher, pluginRoutes: [] })
    expect((await client.pluginRequest({ kind: 'resource', path: 'example/status' })).status).toBe(401)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValue(new Response(JSON.stringify(discovery), { headers: { 'content-type': 'application/json' } }))
    await expect(client.pluginRequest({ kind: 'management', path: 'config', method: 'GET' })).rejects.toMatchObject({ statusCode: 404 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('adapts declared plugin HTML and script URLs to local proxies without modifying binary assets', () => {
    const html = new TextEncoder().encode('<script src="/v0/resource/plugins/example/assets/app.js"></script><script>fetch("/v0/management/example/refresh")</script>')
    const adapted = new TextDecoder().decode(adaptCpaResourceBody(html, 'text/html; charset=utf-8'))
    expect(adapted).toContain('/api/cpa/resources/example/assets/app.js')
    expect(adapted).toContain('/api/cpa/plugin-management/example/refresh')
    const binary = new Uint8Array([0, 255, 128])
    expect(adaptCpaResourceBody(binary, 'image/png')).toBe(binary)
    expect(adaptCpaResourceBody(html, 'text/html; charset=gbk')).toBe(html)
  })
})
