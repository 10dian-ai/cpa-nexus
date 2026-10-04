import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { getCpaCapabilities, type CpaCapabilitiesClient } from '../server/lib/cpa/capabilities'
import { createCpaClient } from '../server/lib/cpa/client'
const response = (body: unknown, status = 200) => ({ status, statusText: 'OK', headers: new Headers({ 'x-cpa-version': '8.0.11' }), body: Buffer.from(JSON.stringify(body)) })
const client = (plugins: unknown[] = [], enabled = false, providers: unknown[] = [], credentials: unknown[] = []): CpaCapabilitiesClient => ({
  request: async input => response(input.path === 'config' ? { 'config-version': 8, plugins: { enabled } } : input.path === 'plugins' ? { plugins_enabled: enabled, plugins } : { files: credentials }),
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
  it('does not invent available providers after the actual core configuration check fails', async () => {
    const result = await getCpaCapabilities({ request: async () => response({ error: 'private-core-error-token' }, 401) })
    expect(result.connected).toBe(false)
    expect(result.oauthProviders.every(provider => !provider.available)).toBe(true)
    expect(result.quotaProviders.every(provider => !provider.available)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-core-error-token')
  })
  it('publishes every runtime-advertised plugin role and configuration descriptor without limiting providers to Google', async () => {
    const result = await getCpaCapabilities(client([
      { id: 'third-party-executor', enabled: true, registered: true, effective_enabled: true, metadata: { name: 'Third-party provider' }, executor_model_scope: 'both',
        capabilities: { executor: true, modelRegistrar: true, scheduler: false, futureRole: true, privateSetting: 'synthetic-private-setting' },
        config_fields: [{ name: 'api_key', type: 'string', description: 'Provider credential' }, { name: 'mode', type: 'enum', enum_values: ['fast', 'complete'] }],
        menus: [{ path: '/v0/resource/plugins/third-party-executor/index.html', menu: 'Provider settings', description: 'Custom provider UI' }] },
      { id: 'github-copilot', enabled: true, registered: true, effective_enabled: true, supports_oauth: true, oauth_provider: 'github-copilot',
        capabilities: { authProvider: true, modelProvider: true, executor: true } },
    ], true))
    expect(result.plugins?.find(plugin => plugin.id === 'third-party-executor')).toMatchObject({ effectiveEnabled: true, registered: true, executorModelScope: 'both',
      capabilities: { executor: true, modelRegistrar: true, scheduler: false, futureRole: true },
      configFields: [{ name: 'api_key', type: 'string', description: 'Provider credential', enumValues: [] }, { name: 'mode', type: 'enum', description: '', enumValues: ['fast', 'complete'] }],
      menus: [{ path: '/v0/resource/plugins/third-party-executor/index.html', name: 'Provider settings', description: 'Custom provider UI' }] })
    expect(result.oauthProviders.find(provider => provider.id === 'github-copilot')).toMatchObject({ available: true, source: 'plugin', pluginId: 'github-copilot' })
    expect(JSON.stringify(result)).not.toContain('synthetic-private-setting')
  })
  it('does not invent a full role matrix on an unmodified stock core or show a disabled global quota plugin as available', async () => {
    const result = await getCpaCapabilities(client([{ id: 'stock-plugin', enabled: true, registered: true, effective_enabled: false }], false,
      [{ plugin_id: 'legacy-quota', provider: 'legacy-quota', supported_providers: ['custom'], supports_reset: true }]))
    expect(result.plugins?.find(plugin => plugin.id === 'stock-plugin')?.capabilities).toEqual({})
    expect(result.quotaProviders.find(provider => provider.pluginId === 'legacy-quota')).toMatchObject({ available: false, supportsReset: true })
  })
  it('preserves all built-in OAuth and native quotas when config is healthy but the plugin directory fails over real local HTTP', async () => {
    const calls: string[] = []
    const upstream = createServer((request, reply) => {
      calls.push(request.url || '')
      reply.setHeader('content-type', 'application/json')
      reply.setHeader('x-cpa-version', 'v8.0.11')
      if (request.url === '/v8/management/config') reply.end(JSON.stringify({ 'config-version': 8, plugins: { enabled: true }, privateSetting: 'synthetic-config-private-value' }))
      else if (request.url === '/v8/management/plugins') { reply.statusCode = 500; reply.end(JSON.stringify({ error: 'plugin_directory_invalid', message: 'synthetic-private-plugin-directory' })) }
      else if (request.url === '/v0/management/quota/providers') reply.end(JSON.stringify({ providers: [{ plugin_id: 'quota-extra', provider: 'extra', supported_providers: ['extra'] }] }))
      else if (request.url === '/v8/management/credentials') reply.end(JSON.stringify({ files: [] }))
      else { reply.statusCode = 404; reply.end('{}') }
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const result = await getCpaCapabilities(createCpaClient({ baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, managementKey: 'synthetic-test-management' }))
      expect(result).toMatchObject({ connected: true, coreVersion: 'v8.0.11', pluginsEnabled: true })
      expect(result.oauthProviders.filter(provider => provider.source === 'core')).toHaveLength(8)
      expect(result.oauthProviders.filter(provider => provider.source === 'core').every(provider => provider.available)).toBe(true)
      expect(result.quotaProviders.filter(provider => provider.source === 'core-api-call')).toHaveLength(7)
      expect(result.quotaProviders.filter(provider => provider.source === 'core-api-call').every(provider => provider.available)).toBe(true)
      expect(result.oauthProviders.find(provider => provider.id === 'gemini-cli')).toMatchObject({ available: false, message: expect.stringContaining('尚未确认') })
      expect(result.quotaProviders.find(provider => provider.pluginId === 'quota-extra')).toMatchObject({ available: false, message: expect.stringContaining('尚未确认') })
      expect(result.errors).toContain('CPA 插件发现暂时不可用，请检查插件目录或插件配置。')
      expect(calls.sort()).toEqual(['/v0/management/quota/providers', '/v8/management/config', '/v8/management/credentials', '/v8/management/plugins'].sort())
      expect(JSON.stringify(result)).not.toContain('synthetic-config-private-value')
      expect(JSON.stringify(result)).not.toContain('synthetic-private-plugin-directory')
    } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
  })
  it('uses core authentication status even when plugin discovery reports a running OAuth plugin', async () => {
    const result = await getCpaCapabilities({ request: async input => response(input.path === 'config' ? { error: 'unauthorized' } : { plugins_enabled: true, plugins: [{ id: 'custom-oauth', effective_enabled: true, supports_oauth: true, oauth_provider: 'custom-oauth' }] }, input.path === 'config' ? 401 : 200) })
    expect(result.connected).toBe(false)
    expect(result.oauthProviders.every(provider => !provider.available)).toBe(true)
    expect(result.quotaProviders.every(provider => !provider.available)).toBe(true)
    expect(result.errors).toContain('CPA 原生配置暂时无法读取，请检测内核连接。')
  })
  it('does not treat a non-v8 configuration response as a confirmed core connection', async () => {
    const result = await getCpaCapabilities({ request: async input => response(input.path === 'config' ? { 'config-version': 7 } : { plugins_enabled: false, plugins: [] }) })
    expect(result.connected).toBe(false)
    expect(result.oauthProviders.filter(provider => provider.source === 'core').every(provider => !provider.available)).toBe(true)
  })
})
