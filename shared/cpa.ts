export interface CpaStatusError {
  code: string
  message: string
  statusCode?: number
}

export interface CpaStatus {
  configured: boolean
  connected: boolean
  apiVersion: 'v8'
  /** Installed version reported by CPA itself; never the latest release tag. */
  version: string | null
  checkedAt: string
  /** Only capabilities verified by this status check. */
  capabilities: string[]
  error: CpaStatusError | null
}

export interface CpaOAuthCapability {
  id: string
  name: string
  available: boolean
  source: 'core' | 'plugin'
  pluginId?: string
  flow: 'browser' | 'device'
  supportsCallback: boolean
  supportsCodeImport?: boolean
  message?: string
}
export interface CpaQuotaCapability {
  id: string
  name: string
  available: boolean
  source: 'core-api-call' | 'plugin' | 'probe'
  pluginId?: string
  credentialProviders: string[]
  provider?: string
  authIndices?: string[]
  supportsReset?: boolean
  message?: string
}
export interface CpaCapabilities {
  connected: boolean
  checkedAt: string
  coreVersion?: string | null
  pluginsEnabled: boolean
  oauthProviders: CpaOAuthCapability[]
  quotaProviders: CpaQuotaCapability[]
  errors?: string[]
}
export interface CpaQuotaWindow {
  id: string
  name: string
  usedPercent?: number
  used?: number
  limit?: number
  remaining?: number
  remainingPercent?: number
  resetsAt?: string
}
export interface CpaNativeQuota {
  provider: string
  authIndex: string
  checkedAt: string
  source: 'core-api-call'
  raw: Record<string, unknown>
  windows: CpaQuotaWindow[]
  errors?: string[]
}
