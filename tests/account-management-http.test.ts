import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiErrorMessage } from '../app/composables/useApiAction'

const fixture = vi.hoisted(() => ({ patch: vi.fn() }))
vi.mock('../server/lib/accounts', () => ({ patchAccount: fixture.patch }))
import patchAccount from '../server/api/accounts/[id].patch'

const ID = '11111111-1111-4111-8111-111111111111'
describe('account edit HTTP validation', () => {
  let server: Server | undefined
  let baseUrl: string
  beforeEach(async () => {
    fixture.patch.mockReset().mockImplementation(async (id, fields) => ({ id, ...fields }))
    const router = createRouter().patch('/api/accounts/:id', patchAccount)
    const app = createApp().use(router)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
  })
  const update = (fields: unknown, id = ID) => fetch(baseUrl + '/api/accounts/' + id, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields),
    signal: AbortSignal.timeout(1500),
  })
  it('allows saving an unnamed pending account and explicitly clearing an optional label', async () => {
    for (const label of ['', '  ']) {
      const response = await update({ label, groupName: '', note: '', enabled: false, maxConcurrency: 2 })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ id: ID, label: '', enabled: false })
      expect(fixture.patch).toHaveBeenLastCalledWith(ID, { label: '', groupName: '', note: '', enabled: false, maxConcurrency: 2 })
    }
  })
  it('accepts the documented upper form limits', async () => {
    const fields = { label: 'a'.repeat(200), groupName: 'g'.repeat(100), note: 'n'.repeat(5000), maxConcurrency: 100 }
    const response = await update(fields)
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    expect(fixture.patch).toHaveBeenCalledWith(ID, fields)
  })
  it('rejects empty, unknown and out-of-range changes before updating storage', async () => {
    for (const fields of [{}, { ignored: true }, { maxConcurrency: 0 }, { maxConcurrency: 101 },
      { maxConcurrency: 2.5 }, { maxConcurrency: '2' }, { enabled: 'false' }, { label: 'a'.repeat(201) }, { note: 'n'.repeat(5001) }]) {
      const response = await update(fields)
      expect(response.status).toBe(400)
      await response.arrayBuffer()
    }
    expect(fixture.patch).not.toHaveBeenCalled()
  })
  it('returns explicit errors for invalid IDs and missing accounts', async () => {
    const invalid = await update({ enabled: false }, 'invalid')
    expect(invalid.status).toBe(400)
    await invalid.arrayBuffer()
    expect(fixture.patch).not.toHaveBeenCalled()
    fixture.patch.mockResolvedValueOnce(null)
    const missing = await update({ enabled: false })
    expect(missing.status).toBe(404)
    await missing.arrayBuffer()
  })
})

describe('localized API errors', () => {
  it('prefers the full message to an ASCII-sanitized HTTP status message', () => {
    expect(apiErrorMessage({ data: { message: '请填写 1 至 80 字的密钥名称', statusMessage: ' 1  80 ' } }))
      .toBe('请填写 1 至 80 字的密钥名称')
  })
  it('retains compatibility with H3 responses that only include statusMessage', () => {
    expect(apiErrorMessage({ data: { statusMessage: '操作未完成' } })).toBe('操作未完成')
  })
})
