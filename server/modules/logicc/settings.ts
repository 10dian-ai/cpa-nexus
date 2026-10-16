import { z } from 'zod'
import { getDb } from '../../lib/db'
import { decryptSecret, encryptSecret } from '../../lib/crypto'
import { DEFAULT_LOGICC_SETTINGS, LOGICC_TOKEN_FAMILIES, type LogiccSettings } from '../../../shared/logicc'

const factor = z.number().min(1).max(5)
const pair = z.object({ input: factor, output: factor }).strict()
const modelName = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/)
export const logiccSettingsSchema = z.object({
  syncIntervalMinutes: z.number().int().min(2).max(1440),
  defaultMaxConcurrency: z.number().int().min(0).max(1000),
  maxAccountAttempts: z.number().int().min(1).max(10),
  toolPolicy: z.enum(['emulate', 'reject']),
  usage: z.object({
    promptOverheadTokens: z.number().int().min(0).max(100_000),
    completionOverheadTokens: z.number().int().min(0).max(100_000),
    factors: z.object(Object.fromEntries(LOGICC_TOKEN_FAMILIES.map(family => [family, pair])) as Record<typeof LOGICC_TOKEN_FAMILIES[number], typeof pair>).strict(),
    autoCalibrate: z.boolean(),
    anthropicCountModel: modelName,
    geminiCountModel: modelName,
  }).strict(),
}).strict()
/** Secrets are replaced only when provided; `null` clears one. */
export const logiccSecretsSchema = z.object({
  anthropicCountKey: z.string().trim().min(10).max(500).nullable().optional(),
  geminiCountKey: z.string().trim().min(10).max(500).nullable().optional(),
}).strict()
export type LogiccSecrets = { anthropicCountKey: string | null; geminiCountKey: string | null }

function merge(stored: unknown): LogiccSettings {
  const value = stored && typeof stored === 'object' ? stored as Partial<LogiccSettings> & { usage?: Partial<LogiccSettings['usage']> } : {}
  const usage = { ...DEFAULT_LOGICC_SETTINGS.usage, ...(value.usage || {}) }
  usage.factors = Object.fromEntries(LOGICC_TOKEN_FAMILIES.map(family => [family, { ...DEFAULT_LOGICC_SETTINGS.usage.factors[family], ...(value.usage?.factors?.[family] || {}) }])) as LogiccSettings['usage']['factors']
  const candidate = { ...DEFAULT_LOGICC_SETTINGS, ...value, usage }
  delete (candidate as { secrets?: unknown }).secrets
  const parsed = logiccSettingsSchema.safeParse(candidate)
  return parsed.success ? parsed.data as LogiccSettings : DEFAULT_LOGICC_SETTINGS
}

let cached: { value: LogiccSettings; secrets: LogiccSecrets; until: number } | undefined
export function resetLogiccSettingsCache() { cached = undefined }
async function load() {
  if (cached && cached.until > Date.now()) return cached
  const rows = await getDb()`SELECT value FROM nexus_module_settings WHERE module_id='logicc'`
  const stored = rows[0]?.value as Record<string, any> | undefined
  const reveal = (value: unknown) => { try { return typeof value === 'string' && value ? decryptSecret(value) : null } catch { return null } }
  cached = { value: merge(stored), secrets: { anthropicCountKey: reveal(stored?.secrets?.anthropicCountKey), geminiCountKey: reveal(stored?.secrets?.geminiCountKey) }, until: Date.now() + 5000 }
  return cached
}
export async function getLogiccSettings(): Promise<LogiccSettings> { return structuredClone((await load()).value) }
export async function getLogiccSecrets(): Promise<LogiccSecrets> { return { ...(await load()).secrets } }

export async function saveLogiccSettings(input: unknown, secretsInput: unknown = {}): Promise<LogiccSettings> {
  const value = logiccSettingsSchema.parse(input) as LogiccSettings
  const secrets = logiccSecretsSchema.parse(secretsInput ?? {})
  await getDb().begin(async tx => {
    const rows = await tx`SELECT value FROM nexus_module_settings WHERE module_id='logicc' FOR UPDATE`
    const previous = (rows[0]?.value?.secrets || {}) as Record<string, string>
    const next: Record<string, string> = { ...previous }
    for (const name of ['anthropicCountKey', 'geminiCountKey'] as const) {
      const provided = secrets[name]
      if (provided === null) delete next[name]
      else if (typeof provided === 'string') next[name] = encryptSecret(provided)
    }
    const stored = { ...value, secrets: next }
    await tx`INSERT INTO nexus_module_settings(module_id,value) VALUES('logicc',${tx.json(stored as any)})
      ON CONFLICT(module_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`
  })
  cached = undefined
  return getLogiccSettings()
}
