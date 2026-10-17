import type { GroupBinding } from './groups'

export type LogiccAccountStatus = 'pending' | 'ready' | 'credential_expired' | 'sync_error' | 'needs_login'
/** How the account authenticates: a refreshable Clerk client, a fixed session JWT, or email+password sign-in. */
export type LogiccCredentialKind = 'client' | 'jwt' | 'password'

export interface LogiccModel { id: string; name: string; provider: string; isDefault: boolean }

export interface LogiccAccountView extends GroupBinding {
  id: string
  label: string
  note: string
  /** Session identifier with the middle masked, e.g. `sess_2ab…9xz`. */
  sessionHint: string | null
  credentialKind: LogiccCredentialKind
  /** Whether a stored email+password lets the session be renewed by signing in. */
  canSignIn: boolean
  /** Masked login email (e.g. `a***@gmail.com`) when one is stored. */
  loginHint: string | null
  /** Try to renew this account's session automatically with its stored password. */
  autoLogin: boolean
  enabled: boolean
  status: LogiccAccountStatus
  /** Concurrent requests this account may serve; 0 means unlimited. */
  maxConcurrency: number
  inFlight: number
  cooldownUntil: string | null
  models: LogiccModel[]
  syncError: string | null
  tokenExpiresAt: string | null
  lastSyncAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

/** Tokenizer families used for local usage calculation. */
export const LOGICC_TOKEN_FAMILIES = ['openai', 'claude', 'gemini', 'other'] as const
export type LogiccTokenFamily = typeof LOGICC_TOKEN_FAMILIES[number]
export interface LogiccFactorPair { input: number; output: number }

export interface LogiccUsageSettings {
  /**
   * Fixed tokens added to every request's input. Logicc wraps each prompt in
   * its own hidden instructions that are never visible to this platform.
   */
  promptOverheadTokens: number
  /** Fixed tokens added to every response's output. */
  completionOverheadTokens: number
  /** Minimum multiplier per tokenizer family. Never below 1: estimates may over-count, never under-count. */
  factors: Record<LogiccTokenFamily, LogiccFactorPair>
  /** Raise factors automatically when an official token count exceeds the local estimate. */
  autoCalibrate: boolean
  /** Model used for Anthropic's free token counting endpoint. */
  anthropicCountModel: string
  /** Model used for Gemini's free token counting endpoint. */
  geminiCountModel: string
}

export interface LogiccSettings {
  /** Minutes between background credential/model checks of each account. */
  syncIntervalMinutes: number
  /** Concurrency given to newly added accounts; 0 means unlimited. */
  defaultMaxConcurrency: number
  /** Different accounts tried for one request before it fails over. */
  maxAccountAttempts: number
  /**
   * `emulate`: client tools are described in the prompt and parsed back into
   * standard tool calls. `reject`: requests carrying client tools are handed
   * to the next source so Logicc only serves plain conversations.
   */
  toolPolicy: 'emulate' | 'reject'
  /** Renew an expired session automatically with the account's stored password (when present). */
  autoLogin: boolean
  usage: LogiccUsageSettings
}

export const DEFAULT_LOGICC_SETTINGS: LogiccSettings = {
  syncIntervalMinutes: 10,
  defaultMaxConcurrency: 2,
  maxAccountAttempts: 3,
  toolPolicy: 'emulate',
  autoLogin: true,
  usage: {
    promptOverheadTokens: 256,
    completionOverheadTokens: 8,
    factors: {
      openai: { input: 1.05, output: 1.05 },
      claude: { input: 1.25, output: 1.25 },
      gemini: { input: 1.15, output: 1.15 },
      other: { input: 1.3, output: 1.3 },
    },
    autoCalibrate: true,
    anthropicCountModel: 'claude-sonnet-4-5',
    geminiCountModel: 'gemini-2.5-flash',
  },
}

/** Settings as shown to the admin: secrets are reduced to "configured" flags. */
export interface LogiccSettingsView extends LogiccSettings {
  anthropicCountKeySet: boolean
  geminiCountKeySet: boolean
  /** Factors raised by calibration, per family; effective = max(configured, calibrated). */
  calibrated: Record<LogiccTokenFamily, LogiccFactorPair & { samples: number }>
}

export interface LogiccOverview {
  accounts: { total: number; enabled: number; ready: number; needsAttention: number; pending: number }
  inFlight: number
  models: { id: string; name: string; accounts: number }[]
  bridge: { connected: boolean; channel: string; modelCount: number; updatedAt: string | null; error: string | null }
  requests: { total: number; success: number; failed: number; estimatedUsage: number }
}
