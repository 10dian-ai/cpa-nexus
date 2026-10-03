import { describe, expect, it } from 'vitest'
import { getCpaCapabilities, type CpaCapabilitiesClient } from '../server/lib/cpa/capabilities'
const response = (body: unknown, status = 200) => ({ status, statusText: 'OK', headers: new Headers({ 'x-cpa-version': '8.0.11' }), body: Buffer.from(JSON.stringify(body)) })
const client = (plugins: unknown[] = [], enabled = false, providers: unknown[] = [], credentials: unknown[] = []): CpaCapabilitiesClient => ({
  request: async input => response(input.path === 'plugins' ? { plugins_enabled: enabled, plugins } : { files: credentials }),
  legacyQuotaRequest: async () => response({ providers }),
})
describe('actual CPA native and plugin capability discovery', () => {
  it('lists all eight real built-in flows and keeps missing Google plugin unavailable', async () => {
    const result = await getCpaCapabilities(client())
    expect(result).toMatchObject({ connected: true, coreVersion: '8.0.11', pluginsEnabled: false })
    expect(result.oauthProviders.filter(provider => provider.source === 'core').map(provider => provider.id)).toEqual(['claude', 'codex', 'antigravity', 'devin', 'kimi', 'kimi-ai', 'xai', 'meta'])
    expect(result.oauthProviders.find(provider => provider.id === 'kimi')).toMatchObject({ flow: 'device', supportsCallback: false })
    expect(result.oauthProviders.find(provider => provider.id === 'claude')).toMatchObject({ flow: 'browser', supportsCallback: true })
    expect(result.oauthProviders.find(provider => provider.id === 'gemini-cli')).toMatchObject({ available: false, source: 'plugin', pluginId: 'gemini-cli' })
    expect(result.quotaProviders.filter(provider => provider.source === 'core-api-call')).toHaveLength(7)
  })
  it('uses actual effective plugin fields and real supported providers/reset metadata', async () => {
    const result = await getCpaCapabilities(client([
      { id: 'gemini-cli', effective_enabled: true, supports_oauth: true, oauth_provider: 'gemini-cli', metadata: { name: 'Google Gemini CLI' } },
      { id: 'quota-extra', effective_enabled: true, supports_quota: true, quota_provider: 'extra' },
    ], true, [{ plugin_id: 'quota-extra', provider: 'extra', supported_providers: ['extra', 'extra-v2'], supports_reset: true }]))
    expect(result.oauthProviders.find(provider => provider.id === 'gemini-cli')).toMatchObject({ available: true })
    expect(result.quotaProviders.find(provider => provider.pluginId === 'quota-extra')).toMatchObject({ available: true, credentialProviders: ['extra', 'extra-v2'], supportsReset: true })
  })
  it('retains explicit unavailable plugin status and discovers only credentials with declarative probes', async () => {
    const result = await getCpaCapabilities(client([{ id: 'gemini-cli', effective_enabled: false, supports_oauth: true, oauth_provider: 'gemini-cli' }], true, [], [{ provider: 'custom', auth_index: 'test-index', quota_probe: { url: 'https://provider.invalid/usage', header: { authorization: 'private-not-returned' } } }]))
    expect(result.oauthProviders.find(provider => provider.id === 'gemini-cli')).toMatchObject({ available: false })
    expect(result.quotaProviders.find(provider => provider.source === 'probe')).toMatchObject({ available: true, credentialProviders: ['custom'], authIndices: ['test-index'] })
    expect(JSON.stringify(result)).not.toContain('private-not-returned')
    expect(JSON.stringify(result)).not.toContain('provider.invalid')
  })
  it('does not invent available providers after core discovery fails', async () => {
    const result = await getCpaCapabilities({ request: async () => response({ error: 'private-core-error-token' }, 401) })
    expect(result.connected).toBe(false)
    expect(result.oauthProviders.every(provider => !provider.available)).toBe(true)
    expect(result.quotaProviders.every(provider => !provider.available)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-core-error-token')
  })
})
