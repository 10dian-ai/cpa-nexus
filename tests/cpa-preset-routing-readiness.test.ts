import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ credentials: [] as Record<string, unknown>[], models: [] as unknown[], calls: 0, config: [] as Record<string, unknown>[], request: vi.fn() }))
vi.mock('../server/lib/cpa/client', () => ({ createCpaClient: () => ({ request: fixture.request }) }))
vi.mock('../server/lib/cpa/preset-config-routing', () => ({ readCpaConfigAccountRoutes: async () => fixture.config, ensureCpaConfigAccountRoute: async () => {} }))
vi.mock('../server/lib/db', () => ({ getDb: () => {
  const sql: any = async () => []
  sql.begin = async (callback: any) => callback(sql)
  return sql
} }))
import { ensureCpaPresetAccountRoute, listCpaPresetAccountRoutes, resetCpaPresetAccountRoutes } from '../server/lib/cpa/preset-routing'
const response = (body: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(body)) })
beforeEach(() => {
  fixture.credentials = []; fixture.models = []; fixture.calls = 0; fixture.config = []
  resetCpaPresetAccountRoutes()
  fixture.request.mockImplementation(async (input: any) => {
    if (input.path === 'credentials') return response({ files: fixture.credentials })
    if (input.path === 'credentials/download') return response({ prefix: 'selected', access_token: 'server-only-test-token' })
    if (input.path === 'credentials/models') { fixture.calls++; return response({ models: fixture.models }) }
    throw new Error('Unexpected read')
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('CPA prefix readiness and virtual source files', () => {
  it('refuses per-account editing for virtual credentials sharing a source filename', async () => {
    fixture.credentials = [{ name: 'source.json', id: 'virtual-a', source: 'file' }, { name: 'source.json', id: 'virtual-b', source: 'file' }]
    expect((await listCpaPresetAccountRoutes()).every(route => !route.supported)).toBe(true)
    await expect(ensureCpaPresetAccountRoute('source.json')).rejects.toMatchObject({ statusCode: 409 })
    expect(fixture.request.mock.calls.some(([input]) => input.path === 'credentials/download')).toBe(false)
  })

  it('waits for an OAuth prefix to appear after the first stale model catalog', async () => {
    fixture.credentials = [{ name: 'oauth.json', id: 'oauth.json', source: 'file' }]
    fixture.models = [{ id: 'old-model' }]
    const implementation = fixture.request.getMockImplementation()!
    fixture.request.mockImplementation(async (input: any) => {
      const result = await implementation(input)
      if (input.path === 'credentials/models' && fixture.calls >= 2) return response({ models: [{ id: 'selected/model' }] })
      return result
    })
    expect(await ensureCpaPresetAccountRoute('oauth.json')).toMatchObject({ supported: true, prefix: 'selected' })
    expect(fixture.calls).toBe(2)
  })

  it('retains a durable config route while unrelated accounts have models and this route is not registered yet', async () => {
    vi.useFakeTimers()
    vi.stubEnv('CPA_URL', 'http://cpa-test.invalid')
    vi.stubEnv('CPA_CLIENT_KEY', 'local-test-client')
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'someone-else/model' }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    fixture.config = [{ accountId: 'config:0123456789abcdef', prefix: 'selected', supported: true, name: 'Local configuration account' }]
    const pending = ensureCpaPresetAccountRoute('config:0123456789abcdef')
    await vi.advanceTimersByTimeAsync(3100)
    expect(await pending).toMatchObject({ supported: true, prefix: 'selected', message: '前缀已保存，模型目录尚未就绪，等待模型同步后使用。' })
    expect(fetcher).toHaveBeenCalled()
    for (const [url] of fetcher.mock.calls as unknown as [URL][]) expect(url.pathname).toBe('/v1/models')
  })
})
