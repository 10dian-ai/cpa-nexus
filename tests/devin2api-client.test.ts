import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevin2ApiClient } from '../server/lib/devin2api/client'
import { isDevin2ApiModel, namespaceDevin2ApiModels, parseDevin2ApiModels, stripDevin2ApiModel } from '../server/lib/devin2api/catalog'

describe('Devin 2API sidecar contract', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('normalizes and namespaces OpenAI-compatible model catalogs', () => {
    const models = parseDevin2ApiModels({ data: [{ id: 'cascade', owned_by: 'devin' }, { id: 'cascade' }, { id: '' }, { id: 'devin/unsafe' }] })
    expect(models).toEqual([{ id: 'cascade', object: 'model', owned_by: 'devin' }])
    expect(namespaceDevin2ApiModels(models)[0]?.id).toBe('devin/cascade')
    expect(isDevin2ApiModel('devin/cascade')).toBe(true)
    expect(isDevin2ApiModel('cascade')).toBe(false)
    expect(stripDevin2ApiModel('devin/cascade')).toBe('cascade')
    expect(stripDevin2ApiModel('devin/')).toBeNull()
  })

  it('removes public credentials before adding the internal sidecar key', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    const client = createDevin2ApiClient({ baseUrl: 'http://devin2api:8080', apiKey: 'internal-secret', fetch: fetcher })
    await client.request({ path: '/v1/models', headers: { authorization: 'Bearer public-key', 'x-api-key': 'public-key' } })
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBe('internal-secret')
  })

  it.each(['ftp://devin', 'http://user:password@devin', 'http://devin?query=1'])('rejects unsafe sidecar URL %s', baseUrl => {
    expect(() => createDevin2ApiClient({ baseUrl })).toThrow()
  })
})
