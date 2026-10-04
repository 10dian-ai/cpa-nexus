import { describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ ensure: vi.fn(), reset: vi.fn() }))
vi.mock('../server/lib/cpa/privacy', () => ({ ensureNativeCpaPrivacy: fixture.ensure }))
vi.mock('../server/lib/cpa/group-routing', () => ({ resetCpaGroupRouting: fixture.reset }))
import { applyCpaPrivacyAfterResponse, cpaPrivacyMutation } from '../server/lib/cpa/privacy-hooks'
const body = (status: string) => new TextEncoder().encode(JSON.stringify({ status }))
describe('new native credentials receive default header privacy', () => {
  it('waits for successful imports, fields/config writes and completed OAuth, including original console paths', () => {
    for (const path of ['credentials', 'credentials/fields', 'config/api-keys', 'config.yaml', 'oauth/import', 'v0/management/auth-files', 'v8/management/config']) expect(cpaPrivacyMutation(path, 'POST', 200, body('ok'))).toBe(true)
    expect(cpaPrivacyMutation('oauth/status', 'GET', 200, body('ok'))).toBe(true)
    expect(cpaPrivacyMutation('v0/management/get-auth-status', 'GET', 200, body('ok'))).toBe(true)
    expect(cpaPrivacyMutation('oauth/status', 'GET', 200, body('wait'))).toBe(false)
    expect(cpaPrivacyMutation('credentials', 'POST', 422, body('error'))).toBe(false)
    expect(cpaPrivacyMutation('config', 'GET', 200, body('ok'))).toBe(false)
    expect(cpaPrivacyMutation('requests/api-call', 'POST', 200, body('ok'))).toBe(false)
  })
  it('applies the policy before completing a mutation and invalidates cached source IDs only when changed', async () => {
    fixture.ensure.mockResolvedValueOnce({ changed: true }); fixture.reset.mockClear()
    await applyCpaPrivacyAfterResponse('credentials', 'POST', { status: 200, body: body('ok') })
    expect(fixture.reset).toHaveBeenCalledTimes(1)
    fixture.ensure.mockResolvedValueOnce({ changed: false })
    await applyCpaPrivacyAfterResponse('config', 'PATCH', { status: 200, body: body('ok') })
    expect(fixture.reset).toHaveBeenCalledTimes(1)
    fixture.ensure.mockRejectedValueOnce(new Error('Privacy unavailable'))
    await expect(applyCpaPrivacyAfterResponse('credentials', 'POST', { status: 200, body: body('ok') })).rejects.toThrow('Privacy unavailable')
  })
})
