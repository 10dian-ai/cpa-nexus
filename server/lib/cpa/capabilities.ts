import type { CpaCapabilities, CpaOAuthCapability, CpaQuotaCapability } from '../../../shared/cpa'
import { createCpaClient, type CpaRequest, type CpaResponse } from './client'

export interface CpaCapabilitiesClient {
  request(input: CpaRequest): Promise<CpaResponse>
  legacyQuotaRequest?(input: CpaRequest): Promise<CpaResponse>
}
export const NATIVE_QUOTA_PROVIDERS = [
  { id: 'codex', name: 'Codex', credentialProviders: ['codex'] },
  { id: 'claude', name: 'Anthropic / Claude', credentialProviders: ['claude', 'anthropic'] },
  { id: 'antigravity', name: 'Google Antigravity', credentialProviders: ['antigravity'] },
  { id: 'kimi', name: 'Kimi Code', credentialProviders: ['kimi', 'kimi-ai'] },
  { id: 'devin', name: 'Devin', credentialProviders: ['devin'] },
  { id: 'meta', name: 'Meta / Muse', credentialProviders: ['meta'] },
  { id: 'xai', name: 'xAI / Grok', credentialProviders: ['xai'] },
] as const
const BUILTIN_OAUTH = [
  ['claude', 'Anthropic / Claude', 'browser'], ['codex', 'OpenAI Codex', 'browser'],
  ['antigravity', 'Google Antigravity', 'browser'], ['devin', 'Devin', 'browser'],
  ['kimi', 'Kimi Code 中国站', 'device'], ['kimi-ai', 'Kimi Code 国际站', 'device'],
  ['xai', 'xAI / Grok', 'device'], ['meta', 'Meta / Muse', 'device'],
] as const
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 160) : ''
const providerId = (value: unknown) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(text(value)) ? text(value) : ''
function parse(response: CpaResponse): Record<string, unknown> | null {
  if (response.status < 200 || response.status >= 300) return null
  try { const value: unknown = JSON.parse(new TextDecoder().decode(response.body)); return record(value) ? value : null } catch { return null }
}

/** Exact v8.0.11 built-ins plus capabilities advertised by the running plugin host. No OAuth is initiated here. */
export async function getCpaCapabilities(client: CpaCapabilitiesClient = createCpaClient()): Promise<CpaCapabilities> {
  const errors: string[] = []
  let discovery: Record<string, unknown> | null = null
  let coreVersion: string | null = null
  try {
    const response = await client.request({ path: 'plugins' })
    discovery = parse(response)
    coreVersion = response.headers.get('x-cpa-version')
    if (!discovery || !Array.isArray(discovery.plugins)) { discovery = null; errors.push('CPA 插件能力暂时无法读取，请检测内核连接。') }
  } catch { errors.push('无法读取 CPA 原生能力，请检测内核连接。') }
  const connected = !!discovery, pluginsEnabled = discovery?.plugins_enabled === true
  const oauthProviders: CpaOAuthCapability[] = BUILTIN_OAUTH.map(([id, name, flow]) => ({
    id, name, flow, available: connected, source: 'core', supportsCallback: flow === 'browser', supportsCodeImport: flow === 'browser',
  }))
  const quotaProviders: CpaQuotaCapability[] = NATIVE_QUOTA_PROVIDERS.map(provider => ({ ...provider,
    credentialProviders: [...provider.credentialProviders], source: 'core-api-call', available: connected, supportsReset: false,
    ...(provider.id === 'xai' ? { message: '只查询真实账单和账户信息；不会自动发送付费模型健康测试。' } : {}),
  }))
  const plugins = Array.isArray(discovery?.plugins) ? discovery.plugins.filter(record) : []
  for (const plugin of plugins) {
    const id = providerId(plugin.id)
    if (!id) continue
    const effective = plugin.effective_enabled === true && pluginsEnabled
    const metadata = record(plugin.metadata) ? plugin.metadata : {}
    if (plugin.supports_oauth === true && providerId(plugin.oauth_provider)) {
      const oauthId = providerId(plugin.oauth_provider)
      if (!oauthProviders.some(provider => provider.id === oauthId)) oauthProviders.push({ id: oauthId,
        name: text(metadata.name) || oauthId, source: 'plugin', pluginId: id, available: effective,
        flow: 'browser', supportsCallback: true, supportsCodeImport: true,
        ...(!effective ? { message: '插件尚未有效启用，请检查插件总开关、安装状态和插件配置。' } : {}),
      })
    }
    if (plugin.supports_quota === true) quotaProviders.push({ id: 'plugin:' + id, name: text(metadata.name) || id,
      source: 'plugin', pluginId: id, credentialProviders: providerId(plugin.quota_provider) ? [providerId(plugin.quota_provider)] : [],
      available: effective, supportsReset: false,
    })
  }
  if (!oauthProviders.some(provider => provider.id === 'gemini-cli')) {
    const existing = plugins.find(plugin => plugin.id === 'gemini-cli')
    oauthProviders.push({ id: 'gemini-cli', name: 'Google Gemini CLI', source: 'plugin', pluginId: 'gemini-cli',
      available: false, flow: 'browser', supportsCallback: true, supportsCodeImport: true,
      message: existing ? 'Google Gemini CLI 插件尚未注册或启用，请在插件管理中检查。' : '安装并启用官方 gemini-cli 插件后，可使用 Google OAuth。',
    })
  }
  // v8 exposes plugin quotas, while the provider/reset metadata still belongs to the native v0 API.
  if (client.legacyQuotaRequest) {
    try {
      const response = parse(await client.legacyQuotaRequest({ path: 'quota/providers' }))
      const providers = Array.isArray(response?.providers) ? response.providers.filter(record) : []
      for (const provider of providers) {
        const pluginId = providerId(provider.plugin_id)
        let row = pluginId ? quotaProviders.find(item => item.pluginId === pluginId) : undefined
        const actualProvider = providerId(provider.provider)
        const supported = Array.isArray(provider.supported_providers) ? provider.supported_providers.map(providerId).filter(Boolean)
          : actualProvider ? [actualProvider] : []
        if (!row && actualProvider) {
          row = { id: (pluginId ? 'plugin:' + pluginId : 'probe:' + actualProvider), name: text(provider.display_name) || actualProvider,
            source: pluginId ? 'plugin' : 'probe', ...(pluginId ? { pluginId } : {}), provider: actualProvider,
            credentialProviders: supported, available: connected, supportsReset: provider.supports_reset === true }
          quotaProviders.push(row)
        }
        if (!row) continue
        row.credentialProviders = supported.length ? supported : row.credentialProviders
        row.provider = actualProvider || row.provider
        row.supportsReset = provider.supports_reset === true
        row.name = text(provider.display_name) || row.name
      }
    } catch { errors.push('插件配额提供方信息暂时无法读取；查询能力以实际内核返回为准。') }
  }
  if (connected) {
    try {
      const credentials = parse(await client.request({ path: 'credentials' }))
      const files = Array.isArray(credentials?.files) ? credentials.files.filter(record) : []
      for (const credential of files) {
        const actualProvider = providerId(credential.provider ?? credential.type)
        if (!actualProvider || !record(credential.quota_probe)) continue
        let row = quotaProviders.find(item => item.id === 'probe:' + actualProvider)
        if (!row) {
          row = { id: 'probe:' + actualProvider, name: actualProvider + ' 自定义额度探针', source: 'probe', provider: actualProvider,
            available: true, credentialProviders: [actualProvider], supportsReset: false, authIndices: [],
            message: '仅对实际配置了额度探针的凭据生效。' }
          quotaProviders.push(row)
        }
        const index = providerId(credential.auth_index)
        if (index) row.authIndices = [...new Set([...(row.authIndices || []), index])]
      }
    } catch { errors.push('凭据配额探针能力暂时无法读取。') }
  }
  return { connected, coreVersion, pluginsEnabled, checkedAt: new Date().toISOString(), oauthProviders, quotaProviders,
    ...(errors.length ? { errors } : {}),
  }
}
