import type { ModelModuleId } from './keys'
import type { GroupBinding } from './groups'

export interface UsageWindow { used: number; cap: number; exceeded: boolean; resetAt: number }
export interface AccountSnapshot {
  identity: { id: string; name: string; email: string | null }
  credits: Record<string, unknown>
  windowLimits: { limited?: boolean; exceeded?: string | null; fiveHour?: UsageWindow; weekly?: UsageWindow; monthly?: UsageWindow } | null
  subscription: { planId: string | null; status: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean | null }
  usage: Record<string, unknown> | null
  fetchedAt: string
}
export interface AccountView extends Partial<GroupBinding> {
  id: string; label: string; email: string | null; groupName: string; note: string
  enabled: boolean; quotaPaused: boolean; quotaResumeAt: string | null; status: 'pending' | 'ready' | 'credential_expired' | 'sync_error'
  inFlight: number; hasApiKey: boolean
  observedModels?: {modelId:string;status:"allowed"|"denied"|"cooldown";reason:string|null;cooldownUntil:string|null;lastCheckedAt:string}[]; snapshot: AccountSnapshot | null; syncError: string | null
  lastSyncAt: string | null; lastUsedAt: string | null; createdAt: string
}
export interface SystemSettings {
  activeRefreshSeconds: number; idleRefreshSeconds: number; activeWindowSeconds: number
  refreshConcurrency: number; refreshRatePerSecond: number
  logRetentionDays: number; affinityTtlSeconds: number; maxRequestBodyMb: number
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
  activeRefreshSeconds: 60, idleRefreshSeconds: 300, activeWindowSeconds: 300,
  refreshConcurrency: 2, refreshRatePerSecond: 2,
  logRetentionDays: 30, affinityTtlSeconds: 86400, maxRequestBodyMb: 0,
  upstreamTimeoutSeconds: 600,
  devinDefaultEffort: 'high', devinStripSampling: true,
  imageMaxEdge: 2048, imageQuality: 85,
}
export interface GatewayKeyView extends Partial<GroupBinding> { id: string; name: string; prefix: string; enabled: boolean; moduleId?: ModelModuleId; groupStrategy?: 'failover' | 'mixed'; createdAt: string; lastUsedAt: string | null }
export interface RequestLogView {
  id: string; accountId: string | null; accountLabel: string | null; keyName: string | null
  moduleId?: string | null; sourceId?: string | null
  model: string; protocol: string; status: string; httpStatus: number | null
  durationMs: number; usage: Record<string, unknown> | null; errorMessage: string | null
  createdAt: string; streaming: boolean; responseTruncated: boolean
}
export interface ImportResult { imported: number; updated: number; failed: number; skipped: number; errors: { line: number; message: string }[] }
export interface JobView { id: string; status: string; progress: { processed: number; total: number }; result: ImportResult | null; error: string | null }
export interface ModelView { id: string; name: string; observedAllowed: number; observedDenied: number; unknownAccounts: number; updatedAt: string; eligibleAccounts?: number; unknownSubscriptionAccounts?: number; availabilitySource?: 'official-catalog' }
export interface QuotaTotal { used: number; cap: number; remaining: number; knownAccounts: number; unknownAccounts: number }
export interface DashboardView {
  quota: { accountCount: number; fiveHour: QuotaTotal; weekly: QuotaTotal; monthly: QuotaTotal }
  counts: { total: number; enabled: number; ready: number; needsAttention: number; notSynced: number }
  requests: { total: number; success: number; failed: number; inFlight: number }
  services: { database: boolean; redis: boolean; workerLastSeen: string | null; kernel: boolean }
  lastSyncAt: string | null
}
