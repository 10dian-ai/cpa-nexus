import { z } from 'zod'
import type { TransactionSql } from 'postgres'
import { getDb } from './db'
import { DEFAULT_SETTINGS, type SystemSettings } from '../../shared/types'
import { MAX_ACCOUNT_CONCURRENCY, MAX_GLOBAL_CONCURRENCY, MAX_REFRESH_CONCURRENCY, MAX_REFRESH_RATE_PER_SECOND } from '../../shared/concurrency'

export const accountConcurrencySchema = z.number().int().min(1).max(MAX_ACCOUNT_CONCURRENCY)

export const settingsSchema = z.object({
  globalConcurrency: z.number().int().min(1).max(MAX_GLOBAL_CONCURRENCY),
  // Keep this API field for existing clients. It also controls the current pool.
  defaultAccountConcurrency: accountConcurrencySchema,
  activeRefreshSeconds: z.number().int().min(15).max(3600),
  idleRefreshSeconds: z.number().int().min(60).max(86400),
  activeWindowSeconds: z.number().int().min(60).max(86400),
  refreshConcurrency: z.number().int().min(1).max(MAX_REFRESH_CONCURRENCY),
  refreshRatePerSecond: z.number().int().min(1).max(MAX_REFRESH_RATE_PER_SECOND),
  logRetentionDays: z.number().int().min(1).max(365),
  affinityTtlSeconds: z.number().int().min(60).max(604800),
  // Retain the field for older clients; zero means no imposed body-size cap.
  maxRequestBodyMb: z.number().int().nonnegative().transform(() => 0),
}).strict()
let cached: { value: SystemSettings; until: number } | undefined
const ACCOUNT_CONCURRENCY_LOCK = 71645202

/** Serialize pool changes and imports so a new account cannot retain an old limit. */
export async function readAccountConcurrencyForImport(tx: TransactionSql): Promise<number> {
  await tx`SELECT pg_advisory_xact_lock(${ACCOUNT_CONCURRENCY_LOCK})`
  const rows = await tx`SELECT value FROM app_settings WHERE id = 1`
  return accountConcurrencySchema.parse(rows[0]?.value?.defaultAccountConcurrency ?? DEFAULT_SETTINGS.defaultAccountConcurrency)
}

export async function getSettings(): Promise<SystemSettings> {
  if (cached && cached.until > Date.now()) return { ...cached.value }
  const rows = await getDb()`SELECT value FROM app_settings WHERE id = 1`
  const value = settingsSchema.parse({ ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) })
  cached = { value, until: Date.now() + 5000 }
  return { ...value }
}
export async function saveSettings(input: SystemSettings): Promise<SystemSettings> {
  const value = settingsSchema.parse(input)
  await getDb().begin(async tx => {
    const previous = await readAccountConcurrencyForImport(tx)
    await tx`INSERT INTO app_settings (id,value) VALUES (1,${tx.json(value as any)})
      ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`
    if (previous !== value.defaultAccountConcurrency) {
      await tx`UPDATE managed_accounts SET max_concurrency=${value.defaultAccountConcurrency},updated_at=now()
        WHERE max_concurrency<>${value.defaultAccountConcurrency}`
    }
  })
  cached = { value, until: Date.now() + 5000 }
  return value
}

/** Apply the limit even when it matches the saved pool value, keeping other settings. */
export async function setAccountPoolConcurrency(input: number): Promise<{ settings: SystemSettings; affected: number }> {
  const maxConcurrency = accountConcurrencySchema.parse(input)
  const result = await getDb().begin(async tx => {
    await readAccountConcurrencyForImport(tx)
    const rows = await tx`SELECT value FROM app_settings WHERE id = 1`
    const settings = settingsSchema.parse({ ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}), defaultAccountConcurrency: maxConcurrency })
    await tx`INSERT INTO app_settings (id,value) VALUES (1,${tx.json(settings as any)})
      ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`
    const updated = await tx`UPDATE managed_accounts SET max_concurrency=${maxConcurrency},updated_at=now()
      WHERE max_concurrency<>${maxConcurrency} RETURNING id`
    return { settings, affected: updated.length }
  })
  cached = { value: result.settings, until: Date.now() + 5000 }
  return result
}
