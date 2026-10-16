import type { ModelModuleId } from './keys'
import type { GroupBinding } from './groups'

/** Platform-wide settings. Module-specific settings live with each module. */
export interface SystemSettings {
  logRetentionDays: number
  /** Retained for older clients; zero means no imposed request-body cap. */
  maxRequestBodyMb: number
  /** Upstream silence (seconds) tolerated before a model request is aborted. */
  upstreamTimeoutSeconds: number
  /** Devin thinking level used when a request names none. */
  devinDefaultEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Drop sampling controls for Devin thinking levels. */
  devinStripSampling: boolean
  /** Longest edge (px) for inline request images; 0 sends them unchanged. */
  imageMaxEdge: number
  /** Quality for resized images (40–100). */
  imageQuality: number
}
export const DEFAULT_SETTINGS: SystemSettings = {
  logRetentionDays: 30, maxRequestBodyMb: 0,
  upstreamTimeoutSeconds: 600,
  devinDefaultEffort: 'high', devinStripSampling: true,
  imageMaxEdge: 2048, imageQuality: 85,
}
export interface GatewayKeyView extends Partial<GroupBinding> { id: string; name: string; prefix: string; enabled: boolean; moduleId?: ModelModuleId; groupStrategy?: 'failover' | 'mixed'; createdAt: string; lastUsedAt: string | null }
export interface RequestLogView {
  id: string; keyName: string | null
  /** Source module that served the request (`cpa`, `logicc`). */
  moduleId?: string | null
  /** CPA source ID or module account ID that served the request. */
  sourceId?: string | null
  /** Display name of a module account, when it still exists. */
  sourceLabel?: string | null
  model: string; protocol: string; status: string; httpStatus: number | null
  durationMs: number; usage: Record<string, unknown> | null; errorMessage: string | null
  createdAt: string; streaming: boolean; responseTruncated: boolean
}

/** One rejected or failed line/item of an account import. */
export interface ImportIssue { line: number; message: string }
export interface ImportResult { imported: number; updated: number; failed: number; skipped: number; errors: ImportIssue[] }
export interface JobView {
  id: string; moduleId: string; status: string
  progress: { processed: number; total: number }
  result: ImportResult | null; error: string | null
}

export interface DashboardView {
  modules: { id: string; name: string; accounts: number; ready: number; needsAttention: number; inFlight: number }[]
  requests: { total: number; success: number; failed: number; window: '24h' }
  services: { database: boolean; redis: boolean; workerLastSeen: string | null; kernel: boolean }
}
