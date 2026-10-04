import type { CpaDiscoveredPlugin, CpaStatus } from '#shared/cpa'

export const cpaManagementUrl = (path: string) => `/api/cpa/management/${path.replace(/^\/+/, '')}`

export function useCpaStatus() {
  return useFetch<CpaStatus>('/api/cpa/status', { key: 'nexus-cpa-status' })
}

export interface CpaOAuthProvider {
  id: string
  name: string
  source: 'core' | 'plugin'
  available: boolean
  enabled?: boolean
  pluginId?: string
  reason?: string
  message?: string
  flow?: string
  supportsCallback?: boolean
  supportsCodeImport?: boolean
}
export interface CpaQuotaProvider {
  id: string
  name: string
  source?: 'core' | 'probe' | 'core-api-call' | 'plugin'
  provider?: string
  pluginId?: string
  available: boolean
  enabled?: boolean
  credentialProviders?: string[]
  authIndices?: string[]
  supportsReset?: boolean
  reason?: string
  message?: string
}
export interface CpaManagementCapabilities {
  coreVersion?: string | null
  checkedAt: string
  pluginsEnabled?: boolean
  oauthProviders: CpaOAuthProvider[]
  quotaProviders: CpaQuotaProvider[]
  plugins?: CpaDiscoveredPlugin[]
  errors?: (string | { source?: string; message: string })[]
}
export function useCpaCapabilities() {
  return useFetch<CpaManagementCapabilities>('/api/cpa/capabilities', { key: 'cpa-management-capabilities' })
}

export function cpaCredentialName(value: Record<string, unknown>): string {
  return cpaDisplay(value.name || value.id, '')
}

export function cpaCapabilityError(value: string | { source?: string; message: string }): string {
  return typeof value === 'string' ? value : [value.source, value.message].filter(Boolean).join('：')
}

export function cpaEntries(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  const rows = (value as Record<string, unknown>)[key]
  return Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : []
}

export function cpaDisplay(value: unknown, fallback = '—'): string {
  if (value == null || value === '') return fallback
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export async function cpaDownload(path: string, name: string) {
  const blob = await $fetch<Blob>(cpaManagementUrl(path), { responseType: 'blob' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
