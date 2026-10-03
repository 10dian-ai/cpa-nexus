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
