import { z } from 'zod'
import { getDb } from './db'
import { DEFAULT_SETTINGS, type SystemSettings } from '../../shared/types'
import { MAX_REFRESH_CONCURRENCY, MAX_REFRESH_RATE_PER_SECOND } from '../../shared/concurrency'

import { UPSTREAM_TIMEOUT_LIMITS } from './timeouts'

const settingsShape = {
  activeRefreshSeconds: z.number().int().min(15).max(3600),
  idleRefreshSeconds: z.number().int().min(60).max(86400),
  activeWindowSeconds: z.number().int().min(60).max(86400),
  refreshConcurrency: z.number().int().min(1).max(MAX_REFRESH_CONCURRENCY),
  refreshRatePerSecond: z.number().int().min(1).max(MAX_REFRESH_RATE_PER_SECOND),
  logRetentionDays: z.number().int().min(1).max(365),
  affinityTtlSeconds: z.number().int().min(60).max(604800),
  // Retain the field for older clients; zero means no imposed body-size cap.
  maxRequestBodyMb: z.number().int().nonnegative().transform(() => 0),
  /** Longest silence allowed from an upstream model before the request is aborted. */
  upstreamTimeoutSeconds: z.number().int().min(UPSTREAM_TIMEOUT_LIMITS.min).max(UPSTREAM_TIMEOUT_LIMITS.max),
  /** Devin thinking level used when a request names none. */
  devinDefaultEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  /** Drop temperature/top_p/top_k for Devin thinking levels, as Devin's own CLI does. */
  devinStripSampling: z.boolean(),
  /** Longest edge for inline request images; 0 sends images unchanged. */
  imageMaxEdge: z.number().int().refine(value => value === 0 || (value >= 512 && value <= 8192), '图片最长边需为 0 或 512–8192'),
  /** JPEG/WebP quality used when an image is resized. */
  imageQuality: z.number().int().min(40).max(100),
}
/** API input: unknown fields are rejected. */
export const settingsSchema = z.object(settingsShape).strict()
/** Stored rows may still carry retired fields (e.g. concurrency caps); they are dropped. */
const storedSettingsSchema = z.object(settingsShape).strip()
let cached: { value: SystemSettings; until: number } | undefined
const ACCOUNT_CONCURRENCY_LOCK = 71645202

export async function getSettings(): Promise<SystemSettings> {
  if (cached && cached.until > Date.now()) return { ...cached.value }
  const rows = await getDb()`SELECT value FROM app_settings WHERE id = 1`
  const value = storedSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) }) as SystemSettings
  cached = { value, until: Date.now() + 5000 }
  return { ...value }
}
export async function saveSettings(input: SystemSettings): Promise<SystemSettings> {
  const value = settingsSchema.parse(input) as SystemSettings
  await getDb()`INSERT INTO app_settings (id,value) VALUES (1,${getDb().json(value as any)})
    ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`
  cached = { value, until: Date.now() + 5000 }
  return value
}
