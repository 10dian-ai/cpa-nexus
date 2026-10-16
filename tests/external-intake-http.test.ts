import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createError, createRouter, getHeader, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  disabled: new Set<string>(),
  submitted: [] as { moduleId: string; request: Record<string, unknown> }[],
  jobs: new Map<string, { moduleId: string }>(),
  groupsOk: true,
}))
vi.mock('../server/lib/modules', () => ({ isModuleEnabled: async (id: string) => !fixture.disabled.has(id), requireModule: async () => {} }))
vi.mock('../server/lib/groups', () => ({ assertGroupIds: async () => { if (!fixture.groupsOk) throw createError({ statusCode: 400, message: '分组不存在' }) } }))
vi.mock('../server/lib/queues', () => ({
  submitIntake: async (moduleId: string, request: Record<string, unknown>) => {
    fixture.submitted.push({ moduleId, request })
    return { jobId: '00000000-0000-4000-8000-000000000001', moduleId, accepted: 1, rejected: 0, duplicates: 0, errors: [] }
  },
  getIntakeJobView: async (id: string) => ({ id, moduleId: fixture.jobs.get(id)?.moduleId ?? '', status: 'completed', progress: { processed: 1, total: 1 }, result: null, error: null }),
}))
vi.mock('../server/lib/auth', async importOriginal => {
  const original = await importOriginal<typeof import('../server/lib/auth')>()
  return { ...original, requireAdmin: async () => { throw createError({ statusCode: 401 }) }, requireServiceKey: async (event: any) => {
    const scope = getHeader(event, 'authorization')?.replace('Bearer ', '')
    if (!scope) throw createError({ statusCode: 401 })
    const key = { id: 'svc', name: 'Importer', moduleIds: scope.split(',') }
    event.context.serviceKey = key
    return key
  } }
})
import admin from '../server/middleware/admin'
import listModules from '../server/api/external/modules/index.get'
import submit from '../server/api/external/modules/[id]/accounts.post'
import legacySubmit from '../server/api/external/accounts.post'
import jobView from '../server/api/external/jobs/[id].get'

describe('platform external intake API', () => {
  let server: Server, base: string
  const call = (path: string, scope: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + scope, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  beforeEach(async () => {
    fixture.disabled.clear(); fixture.submitted = []; fixture.jobs.clear(); fixture.groupsOk = true
    const router = createRouter().get('/api/external/modules', listModules).post('/api/external/modules/:id/accounts', submit)
      .post('/api/external/accounts', legacySubmit).get('/api/external/jobs/:id', jobView)
    server = createServer(toNodeListener(createApp().use(admin).use(router)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) })

  it('lists only the modules in the key scope, with their accepted formats', async () => {
    const body = await (await call('/api/external/modules', 'logicc')).json()
    expect(body.key).toEqual({ name: 'Importer' })
    expect(body.modules.map((module: { id: string }) => module.id)).toEqual(['logicc'])
    expect(body.modules[0].formats.length).toBeGreaterThan(2)
    const both = await (await call('/api/external/modules', 'logicc,cpa')).json()
    expect(both.modules.map((module: { id: string }) => module.id).sort()).toEqual(['cpa', 'logicc'])
  })

  it('queues accounts for an allowed, running module and refuses everything else', async () => {
    const accepted = await call('/api/external/modules/logicc/accounts', 'logicc', { text: 'x', groupIds: ['00000000-0000-4000-8000-0000000000aa'] })
    expect(accepted.status).toBe(202); await accepted.arrayBuffer()
    expect(fixture.submitted).toEqual([{ moduleId: 'logicc', request: { text: 'x', groupIds: ['00000000-0000-4000-8000-0000000000aa'] } }])
    const outside = await call('/api/external/modules/cpa/accounts', 'logicc', { text: 'x' })
    expect(outside.status).toBe(403); await outside.arrayBuffer()
    const unknown = await call('/api/external/modules/commandcode/accounts', 'logicc,cpa', { text: 'x' })
    expect(unknown.status).toBe(404); await unknown.arrayBuffer()
    fixture.disabled.add('logicc')
    const stopped = await call('/api/external/modules/logicc/accounts', 'logicc', { text: 'x' })
    expect(stopped.status).toBe(503); await stopped.arrayBuffer()
    expect(fixture.submitted).toHaveLength(1)
  })

  it('validates the body and the requested groups before queueing', async () => {
    for (const body of [{}, { text: '   ' }, { text: 'x', extra: 1 }, { text: 'x', groupIds: ['not-a-uuid'] }]) {
      const response = await call('/api/external/modules/logicc/accounts', 'logicc', body)
      expect(response.status).toBe(400); await response.arrayBuffer()
    }
    fixture.groupsOk = false
    const response = await call('/api/external/modules/logicc/accounts', 'logicc', { text: 'x', groupIds: ['00000000-0000-4000-8000-0000000000aa'] })
    expect(response.status).toBe(400); await response.arrayBuffer()
    expect(fixture.submitted).toEqual([])
  })

  it('keeps the legacy endpoint for single-module keys', async () => {
    const response = await call('/api/external/accounts', 'logicc', { cookie: 'c', token: 't' })
    expect(response.status).toBe(202); await response.arrayBuffer()
    expect(fixture.submitted[0]).toEqual({ moduleId: 'logicc', request: { text: 't\nc' } })
    const ambiguous = await call('/api/external/accounts', 'logicc,cpa', { text: 'x' })
    expect(ambiguous.status).toBe(400); await ambiguous.arrayBuffer()
  })

  it('shows jobs only to keys scoped to the job\'s module', async () => {
    fixture.jobs.set('00000000-0000-4000-8000-00000000000b', { moduleId: 'cpa' })
    const own = await call('/api/external/jobs/00000000-0000-4000-8000-00000000000b', 'cpa')
    expect(own.status).toBe(200); await own.arrayBuffer()
    const other = await call('/api/external/jobs/00000000-0000-4000-8000-00000000000b', 'logicc')
    expect(other.status).toBe(404); await other.arrayBuffer()
  })
})
