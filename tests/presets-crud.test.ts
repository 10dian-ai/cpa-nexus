import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ presets: new Map<string, any>(), bindings: new Map<string, any>(), keyBindings: new Map<string, any>(), keys: new Map<string, any>(), accounts: new Set<string>(), enabled: false, prefixCalls: [] as string[], routeReads: 0 }))
vi.mock('../server/lib/modules', () => ({ isModuleEnabled: async () => fixture.enabled }))
vi.mock('../server/lib/cpa/preset-routing', () => ({ ensureCpaPresetAccountRoute: async (id: string) => { fixture.prefixCalls.push(id); if (!id.startsWith('native')) throw Object.assign(new Error('CPA account missing'), { statusCode: 404 }); return { accountId: id, prefix: 'nexus-native' } } }))
vi.mock('../server/lib/db', () => {
  const sql: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim(), now = new Date('2026-10-03T00:00:00Z')
    if (query.startsWith('SELECT pg_advisory')) return []
    if (query.startsWith('SELECT count')) return [{ count: fixture.presets.size }]
    if (query.startsWith('SELECT COALESCE(MAX(sort_order)')) return [{ next_order: Math.max(-1, ...[...fixture.presets.values()].map(row => row.sort_order)) + 1 }]
    if (query.startsWith('SELECT id,name,enabled,sort_order')) return [...fixture.presets.values()].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
    if (query.startsWith('SELECT * FROM nexus_presets WHERE enabled=true')) return [...fixture.presets.values()].filter(row => row.enabled).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
    if (query.startsWith('SELECT * FROM nexus_presets WHERE')) { const row = fixture.presets.get(values[0]); return row ? [row] : [] }
    if (query.startsWith('SELECT * FROM nexus_presets ORDER')) return [...fixture.presets.values()]
    if (query.startsWith('INSERT INTO nexus_presets')) {
      const [id, name, description, source_json, variables, enabled, sort_order] = values
      const row = { id, name, description, source_json, variables, enabled, sort_order, created_at: now, updated_at: now }; fixture.presets.set(id, row); return [row]
    }
    if (query.startsWith('UPDATE nexus_presets SET sort_order=')) { const row = fixture.presets.get(values[1]); row.sort_order = values[0]; row.updated_at = now; return [row] }
    if (query.startsWith('UPDATE nexus_presets')) {
      const [name, description, source_json, variables, enabled, sort_order, id] = values, current = fixture.presets.get(id)
      const row = { ...current, name, description, source_json, variables, enabled, sort_order, updated_at: now }; fixture.presets.set(id, row); return [row]
    }
    if (query.startsWith('SELECT 1 FROM nexus_preset_bindings')) return [...fixture.bindings.values()].filter(row => row.preset_id === values[0]).slice(0, 1)
    if (query.startsWith('SELECT 1 FROM nexus_key_preset_bindings')) return [...fixture.keyBindings.values()].filter(row => row.preset_id === values[0]).slice(0, 1)
    if (query.startsWith('DELETE FROM nexus_presets')) { const exists = fixture.presets.delete(values[0]); return exists ? [{ id: values[0] }] : [] }
    if (query.startsWith('SELECT * FROM nexus_preset_bindings')) return [...fixture.bindings.values()]
    if (query.startsWith('SELECT b.*,k.module_id')) return [...fixture.keyBindings.values()].map(row => ({ ...row, module_id: fixture.keys.get(row.key_id)?.module_id }))
    if (query.startsWith('SELECT b.mode,b.preset_id')) {
      const binding = fixture.keyBindings.get(values[0]), key = fixture.keys.get(values[0])
      return binding && key && !key.prefix.startsWith('ccm_nexus_') && ['commandcode', 'cpa'].includes(key.module_id) ? [binding] : []
    }
    if (query.startsWith('SELECT id,module_id FROM gateway_keys')) {
      const key = fixture.keys.get(values[0])
      return key && !key.prefix.startsWith('ccm_nexus_') && ['commandcode', 'cpa'].includes(key.module_id) ? [key] : []
    }
    if (query.startsWith('SELECT id FROM managed_accounts')) return fixture.accounts.has(values[0]) ? [{ id: values[0] }] : []
    if (query.startsWith('INSERT INTO platform_modules')) return []
    if (query.startsWith('DELETE FROM nexus_key_preset_bindings')) { fixture.keyBindings.delete(values[0]); return [] }
    if (query.startsWith('INSERT INTO nexus_key_preset_bindings')) {
      const [key_id, mode, preset_id] = values, row = { key_id, mode, preset_id, updated_at: now }
      fixture.keyBindings.set(key_id, row); return [row]
    }
    if (query.startsWith('DELETE FROM nexus_preset_bindings')) { fixture.bindings.delete(values.join(':')); return [] }
    if (query.startsWith('INSERT INTO nexus_preset_bindings')) {
      const [module_id, account_id, mode, preset_id] = values, row = { module_id, account_id, mode, preset_id, updated_at: now }
      fixture.bindings.set(`${module_id}:${account_id}`, row); return [row]
    }
    if (query.startsWith('SELECT b.mode,p.*')) {
      fixture.routeReads++
      if (query.includes('nexus_key_preset_bindings')) {
        const binding = fixture.keyBindings.get(values[0]), key = fixture.keys.get(values[0])
        if (query.includes('p.enabled=true') && binding?.mode === 'stack' && key && !key.prefix.startsWith('ccm_nexus_')) return [...fixture.presets.values()].filter(row => row.enabled).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)).map(row => ({ ...row, mode: 'stack' }))
        return binding && key && !key.prefix.startsWith('ccm_nexus_') ? [{ mode: binding.mode, ...fixture.presets.get(binding.preset_id) }] : []
      }
      const [moduleId, accountId] = values, binding = fixture.bindings.get(`${moduleId}:${accountId}`) || fixture.bindings.get(`${moduleId}:`)
      return binding ? [{ mode: binding.mode, ...fixture.presets.get(binding.preset_id) }] : []
    }
    throw new Error('Unexpected fixture query ' + query)
  }
  sql.begin = async (fn: any) => fn(sql); sql.json = (value: any) => value
  return { getDb: () => sql }
})

import listHandler from '../server/api/presets/index.get'
import createHandler from '../server/api/presets/index.post'
import getHandler from '../server/api/presets/[id].get'
import updateHandler from '../server/api/presets/[id].patch'
import deleteHandler from '../server/api/presets/[id].delete'
import exportHandler from '../server/api/presets/[id]/export.get'
import validateHandler from '../server/api/presets/validate.post'
import bindingsHandler from '../server/api/presets/routes.get'
import setBindingHandler from '../server/api/presets/routes.put'
import orderHandler from '../server/api/presets/order.put'
import { resolveKeyPresetRoute, resolveKeyPresetStack, resetPresetRouteCache, updatePreset, setKeyPresetBinding, setPresetBinding } from '../server/lib/presets'

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const keyA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const keyB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const document = { prompts: [{ identifier: 'main', role: 'system', content: 'Prefix' }, { identifier: 'chatHistory', marker: true }], prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], unknown: { preserve: ['all'] } }

describe('persistent preset CRUD, model key routing and request validation', () => {
  let server: Server, base: string
  const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const create = async (sourceJson: unknown = document) => (await (await request('/api/presets', 'POST', { name: 'Demo', sourceJson })).json()) as any
  beforeEach(async () => {
    fixture.presets.clear(); fixture.bindings.clear(); fixture.keyBindings.clear(); fixture.keys.clear(); fixture.accounts.clear(); fixture.prefixCalls = []; fixture.enabled = false; fixture.routeReads = 0; resetPresetRouteCache()
    fixture.keys.set(keyA, { id: keyA, module_id: 'commandcode', prefix: 'ccm_ka' })
    fixture.keys.set(keyB, { id: keyB, module_id: 'cpa', prefix: 'ccm_kb' })
    const router = createRouter()
    router.get('/api/presets', listHandler); router.post('/api/presets', createHandler)
    router.get('/api/presets/routes', bindingsHandler); router.put('/api/presets/routes', setBindingHandler)
    router.put('/api/presets/order', orderHandler)
    router.post('/api/presets/validate', validateHandler)
    router.get('/api/presets/:id/export', exportHandler); router.get('/api/presets/:id', getHandler)
    router.patch('/api/presets/:id', updateHandler); router.delete('/api/presets/:id', deleteHandler)
    const app = createApp(); app.use(router); server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }); vi.restoreAllMocks(); resetPresetRouteCache() })

  it('imports, edits, exports complete JSON while the module is disabled', async () => {
    const response = await request('/api/presets', 'POST', { name: ' Demo ', sourceJson: JSON.stringify(document), description: 'Imported' })
    expect(response.status).toBe(201)
    const created = await response.json() as any
    expect(created).toMatchObject({ name: 'Demo', sourceJson: document, variables: {}, compatibility: { supported: true } })
    expect((await (await request('/api/presets')).json()) as any).toMatchObject({ moduleEnabled: false, presets: [created] })
    const modified = { ...document, temperature: 0.4 }
    expect((await (await request(`/api/presets/${created.id}`, 'PATCH', { name: 'Edited', sourceJson: modified })).json()) as any).toMatchObject({ name: 'Edited', sourceJson: modified })
    const exported = await request(`/api/presets/${created.id}/export`)
    expect(exported.headers.get('content-disposition')).toContain(created.id)
    expect(await exported.json()).toEqual(modified)
    expect(await (await request(`/api/presets/${created.id}`, 'DELETE')).json()).toEqual({ deleted: true })
    expect((await request(`/api/presets/${created.id}`)).status).toBe(404)
  })

  it('persists unsupported imports for editing but rejects key binding without mutating native accounts', async () => {
    const created = await create({ ...document, prompts: [{ identifier: 'main', content: '{{setvar::x::y}}' }, { identifier: 'chatHistory', marker: true }] })
    expect(created.compatibility.supported).toBe(false)
    const response = await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'preset', presetId: created.id })
    expect(response.status).toBe(422); expect(fixture.prefixCalls).toEqual([]); expect(fixture.keyBindings.size).toBe(0)
    const validation = await request('/api/presets/validate', 'POST', { name: 'Validate', sourceJson: document })
    expect(await validation.json()).toMatchObject({ sourceJson: document, compatibility: { supported: true } })
    expect(fixture.presets.size).toBe(1)
  })

  it('applies only the selected key preset and never inherits legacy account or module presets', async () => {
    const created = await create(); fixture.accounts.add(accountId)
    await setPresetBinding({ moduleId: 'commandcode', mode: 'preset', presetId: created.id })
    await setPresetBinding({ moduleId: 'commandcode', accountId, mode: 'preset', presetId: created.id })
    expect((await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'preset', presetId: created.id })).status).toBe(200)
    expect(await resolveKeyPresetRoute(keyB)).toBeNull()
    fixture.enabled = true
    expect((await resolveKeyPresetRoute(keyB))?.id).toBe(created.id)
    expect(await resolveKeyPresetRoute(keyA)).toBeNull()
    expect(await (await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'bypass' })).json()).toMatchObject({ binding: { mode: 'bypass', keyId: keyB, presetId: null } })
    expect(await resolveKeyPresetRoute(keyB)).toBeNull()
    expect(await (await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'inherit' })).json()).toEqual({ binding: null })
    expect(await resolveKeyPresetRoute(keyB)).toBeNull()
  })

  it('keeps separate key presets and follows the current key module binding without account mutations', async () => {
    const first = await create(), second = await create({ ...document, temperature: 0.7 }); fixture.enabled = true
    await request('/api/presets/routes', 'PUT', { keyId: keyA, mode: 'preset', presetId: first.id })
    await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'preset', presetId: second.id })
    expect((await resolveKeyPresetRoute(keyA))?.id).toBe(first.id)
    expect((await resolveKeyPresetRoute(keyB))?.id).toBe(second.id)
    fixture.keys.get(keyB).module_id = 'commandcode'
    expect(fixture.prefixCalls).toEqual([])
    expect((await (await request('/api/presets/routes')).json()) as any).toMatchObject({ bindings: expect.arrayContaining([expect.objectContaining({ moduleId: 'commandcode', keyId: keyB, presetId: second.id })]) })
  })

  it('does not delete bound presets or permit incompatible edits of active routes', async () => {
    const created = await create()
    await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'preset', presetId: created.id })
    expect((await request(`/api/presets/${created.id}`, 'DELETE')).status).toBe(409)
    expect((await request(`/api/presets/${created.id}`, 'PATCH', { sourceJson: { main_prompt: '{{unsupported}}' } })).status).toBe(409)
    expect(fixture.presets.get(created.id).source_json).toEqual(document)
    expect((await request(`/api/presets/${created.id}`, 'PATCH', { name: 'Safe rename' })).status).toBe(200)
    await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'inherit' })
    expect((await request(`/api/presets/${created.id}`, 'DELETE')).status).toBe(200)
  })

  it('accepts large API payloads, validates JSON and allows orphan binding removal', async () => {
    for (const body of [{ name: '', sourceJson: {} }, { name: 'Demo', sourceJson: [] }, { name: 'Demo', sourceJson: {}, extra: true }]) expect((await request('/api/presets', 'POST', body)).status).toBe(400)
    const large = 'x'.repeat(4 * 1024 * 1024)
    const uploaded = await request('/api/presets', 'POST', { name: 'Huge', sourceJson: { text: large } })
    expect(uploaded.status).toBe(201)
    expect((await uploaded.json()).sourceJson.text).toBe(large)
    expect((await request('/api/presets/routes', 'PUT', { keyId: 'unknown', mode: 'bypass' })).status).toBe(400)
    expect((await request('/api/presets/routes', 'PUT', { keyId: accountId, mode: 'bypass' })).status).toBe(404)
    expect((await request('/api/presets/routes', 'PUT', { keyId: keyA, mode: 'bypass', presetId: accountId })).status).toBe(400)
    fixture.keys.set(accountId, { id: accountId, module_id: 'commandcode', prefix: 'ccm_nexus_internal' })
    expect((await request('/api/presets/routes', 'PUT', { keyId: accountId, mode: 'bypass' })).status).toBe(404)
    fixture.keys.delete(accountId)
    fixture.keyBindings.set(accountId, { key_id: accountId, mode: 'bypass', preset_id: null, updated_at: new Date() })
    expect((await request('/api/presets/routes', 'PUT', { keyId: accountId, mode: 'inherit' })).status).toBe(200)
    expect(fixture.keyBindings.size).toBe(0)
  })

  it('bounds route reads with a short cache while updating active routes immediately and rechecking module state', async () => {
    const created = await create(); fixture.enabled = true
    await setKeyPresetBinding({ keyId: keyB, mode: 'preset', presetId: created.id })
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now)
    await resolveKeyPresetRoute(keyB); await resolveKeyPresetRoute(keyB)
    expect(fixture.routeReads).toBe(1)
    fixture.enabled = false; expect(await resolveKeyPresetRoute(keyB)).toBeNull(); expect(fixture.routeReads).toBe(1)
    fixture.enabled = true
    await updatePreset(created.id, { name: 'Updated' })
    expect((await resolveKeyPresetRoute(keyB))?.name).toBe('Updated'); expect(fixture.routeReads).toBe(2)
    now += 2001; await resolveKeyPresetRoute(keyB); expect(fixture.routeReads).toBe(3)
    await setKeyPresetBinding({ keyId: keyB, mode: 'bypass' }); expect(await resolveKeyPresetRoute(keyB)).toBeNull(); expect(fixture.routeReads).toBe(4)
    for (let index = 0; index < 140; index++) await resolveKeyPresetRoute('00000000-0000-4000-8000-' + String(index).padStart(12, '0'))
    const reads = fixture.routeReads; await resolveKeyPresetRoute(keyB); expect(fixture.routeReads).toBe(reads + 1)
  })

  it('shares enabled presets across opted-in keys, persists ordering, and omits documents from the library summary', async () => {
    const first = await create(), second = await create({ ...document, temperature: 0.7 })
    const third = await create()
    expect(first).toMatchObject({ enabled: false, sortOrder: 0 })
    await request(`/api/presets/${first.id}`, 'PATCH', { enabled: true })
    await request(`/api/presets/${second.id}`, 'PATCH', { enabled: true })
    fixture.enabled = true
    await request('/api/presets/routes', 'PUT', { keyId: keyA, mode: 'stack' })
    await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'stack' })
    expect((await resolveKeyPresetStack(keyA)).map(item => item.id)).toEqual([first.id, second.id])
    expect((await resolveKeyPresetStack(keyB)).map(item => item.id)).toEqual([first.id, second.id])
    const order = await request('/api/presets/order', 'PUT', { ids: [second.id, first.id, third.id] })
    expect(order.status).toBe(200)
    expect((await resolveKeyPresetStack(keyA)).map(item => item.id)).toEqual([second.id, first.id])
    const summary = await (await request('/api/presets?view=summary')).json()
    expect(summary.presets.map((item: any) => item.id)).toEqual([second.id, first.id, third.id])
    expect(summary.presets[0]).not.toHaveProperty('sourceJson')
    expect(summary.presets[0]).not.toHaveProperty('variables')
    expect((await request('/api/presets/order', 'PUT', { ids: [first.id, second.id] })).status).toBe(409)
    expect((await request('/api/presets/order', 'PUT', { ids: [first.id, first.id, third.id] })).status).toBe(400)
    await request(`/api/presets/${second.id}`, 'PATCH', { enabled: false })
    expect((await resolveKeyPresetStack(keyA)).map(item => item.id)).toEqual([first.id])
    await request('/api/presets/routes', 'PUT', { keyId: keyB, mode: 'bypass' })
    expect(await resolveKeyPresetStack(keyB)).toEqual([])
    fixture.enabled = false
    expect(await resolveKeyPresetStack(keyA)).toEqual([])
  })

  it('cannot enable incompatible content or break an enabled preset; disabling remains possible', async () => {
    const unsupported = await create({ main_prompt: '{{unknown}}' })
    expect((await request(`/api/presets/${unsupported.id}`, 'PATCH', { enabled: true })).status).toBe(409)
    const first = await create()
    expect((await request(`/api/presets/${first.id}`, 'PATCH', { enabled: true })).status).toBe(200)
    expect((await request(`/api/presets/${first.id}`, 'PATCH', { sourceJson: { main_prompt: '{{unknown}}' } })).status).toBe(409)
    expect((await request(`/api/presets/${first.id}`, 'PATCH', { enabled: false, sourceJson: { main_prompt: '{{unknown}}' } })).status).toBe(200)
  })
})
