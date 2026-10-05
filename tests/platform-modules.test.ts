import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  states: new Map<string, boolean>(), reads: 0,
  cpa: { configured: false, connected: false, apiVersion: 'v8', version: null as string | null, checkedAt: '', capabilities: [], error: { code: 'not_configured', message: 'CPA 尚未配置' } as { code: string; message: string } | null },
}))
vi.mock('../server/lib/db', () => ({
  getDb: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim()
    if (query.startsWith('SELECT enabled FROM platform_modules')) {
      fixture.reads++
      const id = String(values[0])
      return fixture.states.has(id) ? [{ enabled: fixture.states.get(id) }] : []
    }
    if (query.startsWith('SELECT id,enabled')) return [...fixture.states].map(([id, enabled]) => ({ id, enabled }))
    if (query.startsWith('INSERT INTO platform_modules')) { fixture.states.set(String(values[0]), Boolean(values[1])); return [] }
    throw new Error('Unexpected modules fixture query: ' + query)
  },
}))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ kernelUrl: 'http://commandcode.test:3050' }) }))
vi.mock('../server/lib/cpa/client', () => ({ createCpaClient: () => ({ status: async () => fixture.cpa }) }))
vi.mock('../server/lib/commandcode-health',()=>({commandcodeProviderHealthy:async()=>true}))

import { isModuleEnabled, listModules, resetModuleCache, setModuleEnabled } from '../server/lib/modules'
import modulesMiddleware from '../server/middleware/modules'
import updateModuleHandler from '../server/api/modules/[id].patch'

describe('persistent module state and real HTTP gating', () => {
  let server: Server | undefined
  let base: string

  beforeEach(async () => {
    fixture.states.clear(); fixture.reads = 0; resetModuleCache()
    fixture.cpa = { configured: false, connected: false, apiVersion: 'v8', version: null, checkedAt: '', capabilities: [], error: { code: 'not_configured', message: 'CPA 尚未配置' } }
    const app = createApp()
    app.use(modulesMiddleware)
    const router = createRouter()
    for (const path of ['/v1/chat/completions', '/v1/models', '/nexus/cpa/v1/models', '/commandcode/v1/chat/completions', '/commandcode/v1/models', '/api/accounts', '/api/accounts/actions', '/api/external/accounts', '/api/jobs/test', '/api/accounts-other']) {
      router.use(path, defineEventHandler(() => ({ ok: true })))
    }
    router.patch('/api/modules/:id', updateModuleHandler)
    app.use(router)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    vi.restoreAllMocks(); resetModuleCache()
  })

  it('persists a toggle, invalidates cached state immediately, and blocks only new module work', async () => {
    expect(await isModuleEnabled('commandcode')).toBe(true)
    const update = await fetch(base + '/api/modules/commandcode', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' })
    expect(update.status).toBe(200)
    expect(await update.json()).toEqual({ id: 'commandcode', enabled: false })
    expect(fixture.states.get('commandcode')).toBe(false)
    for (const [path, method, expected] of [
      // Unified model handlers validate the selected key's module themselves.
      ['/v1/chat/completions', 'POST', 200], ['/v1/models', 'GET', 200], ['/nexus/cpa/v1/models', 'GET', 200],
      ['/commandcode/v1/chat/completions', 'POST', 503], ['/commandcode/v1/models', 'GET', 503],
      ['/api/accounts', 'POST', 503], ['/api/accounts/actions', 'POST', 503], ['/api/external/accounts', 'POST', 503],
      ['/api/accounts', 'GET', 200], ['/api/external/accounts', 'GET', 200], ['/api/jobs/test', 'GET', 200], ['/api/accounts-other', 'POST', 200],
    ] as const) {
      const response = await fetch(base + path, { method })
      expect(response.status, path + ' ' + method).toBe(expected)
      await response.arrayBuffer()
    }
    await setModuleEnabled('commandcode', true)
    const restored = await fetch(base + '/v1/chat/completions', { method: 'POST' })
    expect(restored.status).toBe(200)
    await restored.arrayBuffer()
  })

  it('rejects unsupported toggles and malformed payloads without mutating persisted state', async () => {
    for (const [id, payload, expected] of [
      ['cpa', { enabled: false }, 409], ['platform', { enabled: false }, 409],
      ['missing', { enabled: true }, 404], ['commandcode', { enabled: 'false' }, 400], ['commandcode', { enabled: false, extra: true }, 400],
    ] as const) {
      const response = await fetch(base + '/api/modules/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      expect(response.status).toBe(expected)
      await response.arrayBuffer()
    }
    expect(fixture.states.size).toBe(0)
  })

  it('keeps the optional preset module off until explicitly enabled and preserves its state', async () => {
    expect(await isModuleEnabled('presets')).toBe(false)
    expect((await listModules()).find(module => module.id === 'presets')).toMatchObject({ enabled: false, status: 'disabled' })
    await setModuleEnabled('presets', true)
    expect(await isModuleEnabled('presets')).toBe(true)
    expect((await listModules()).find(module => module.id === 'presets')).toMatchObject({ enabled: true, status: 'ready' })
    resetModuleCache()
    expect(await isModuleEnabled('presets')).toBe(true)
    await setModuleEnabled('presets', false)
    expect(await isModuleEnabled('presets')).toBe(false)
    expect(await isModuleEnabled('commandcode')).toBe(true)
  })

  it('caches routine state checks but refreshes worker-visible changes after cache expiry', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await isModuleEnabled('commandcode'); await isModuleEnabled('commandcode')
    expect(fixture.reads).toBe(1)
    fixture.states.set('commandcode', false)
    expect(await isModuleEnabled('commandcode')).toBe(true)
    now += 2001
    expect(await isModuleEnabled('commandcode')).toBe(false)
    expect(fixture.reads).toBe(2)
    expect(await isModuleEnabled('cpa')).toBe(true)
    await expect(isModuleEnabled('unknown')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('reports native CPA setup and installed version independently from CommandCode health', async () => {
    const nativeFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'http://commandcode.test:3050/health') return new Response('healthy')
      return nativeFetch(input, init)
    })
    let modules = await listModules()
    expect(modules.find(module => module.id === 'cpa')).toMatchObject({ status: 'unconfigured', runtimeVersion: null })
    expect(modules.find(module => module.id === 'commandcode')).toMatchObject({ status: 'ready' })
    fixture.cpa = { ...fixture.cpa, configured: true, connected: true, version: 'v8.0.15', error: null }
    fixture.states.set('commandcode', false)
    modules = await listModules()
    expect(modules.find(module => module.id === 'cpa')).toMatchObject({ status: 'ready', runtimeVersion: 'v8.0.15' })
    expect(modules.find(module => module.id === 'commandcode')).toMatchObject({ status: 'disabled', enabled: false })
    expect(modules.find(module => module.id === 'platform')).toMatchObject({ status: 'ready', enabled: true })
  })
})
