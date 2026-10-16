import { countTokens } from 'gpt-tokenizer/encoding/o200k_base'
import { getDb } from '../../lib/db'
import { getRedis } from '../../lib/redis'
import { LOGICC_TOKEN_FAMILIES, type LogiccFactorPair, type LogiccSettings, type LogiccTokenFamily } from '../../../shared/logicc'
import { getLogiccSecrets } from './settings'

/**
 * Logicc does not report token usage, yet CPAN sits behind a billing relay.
 * Usage is therefore computed here, from exactly what Logicc received and
 * produced, under one rule: it may over-count, it must never under-count.
 *
 *   input  = ⌈local(prompt sent to Logicc + tool results Logicc fed back) × factor⌉ + fixed overhead
 *   output = ⌈local(text + reasoning + tool-call output Logicc generated) × factor⌉ + fixed overhead
 *
 * `local` is the o200k tokenizer, exact for OpenAI models. Other families use
 * a multiplier ≥ 1 because their tokenizers produce more tokens for the same
 * text. When an official counting key is configured, the provider's own
 * count of the prompt is taken if larger, and every official count can only
 * raise the family's multiplier (calibration never lowers it).
 * The prompt already contains the call group's SillyTavern presets when they
 * apply, so preset tokens are billed to the request that used them.
 */
export function localTokens(text: string): number {
  if (!text) return 0
  return countTokens(text, { disallowedSpecial: new Set() })
}

export function tokenFamily(modelId: string, provider = ''): LogiccTokenFamily {
  const value = `${provider} ${modelId}`.toLowerCase()
  if (/claude|anthropic|sonnet|opus|haiku/.test(value)) return 'claude'
  if (/gemini|gemma|google/.test(value)) return 'gemini'
  if (/(?:^|[\s/_-])(?:gpt|o[1-9]|chatgpt|openai|codex)/.test(value)) return 'openai'
  return 'other'
}

const MAX_FACTOR = 5
let calibrationCache: { value: Record<LogiccTokenFamily, LogiccFactorPair & { samples: number }>; until: number } | undefined
export function resetCalibrationCache() { calibrationCache = undefined }
export async function readCalibration(): Promise<Record<LogiccTokenFamily, LogiccFactorPair & { samples: number }>> {
  if (calibrationCache && calibrationCache.until > Date.now()) return calibrationCache.value
  const value = Object.fromEntries(LOGICC_TOKEN_FAMILIES.map(family => [family, { input: 1, output: 1, samples: 0 }])) as Record<LogiccTokenFamily, LogiccFactorPair & { samples: number }>
  for (const row of await getDb()`SELECT family,direction,factor,samples FROM logicc_usage_calibration`) {
    const entry = value[row.family as LogiccTokenFamily]
    if (!entry) continue
    entry[row.direction as 'input' | 'output'] = Number(row.factor)
    entry.samples += Number(row.samples)
  }
  calibrationCache = { value, until: Date.now() + 30_000 }
  return value
}

export async function effectiveFactors(family: LogiccTokenFamily, settings: LogiccSettings): Promise<LogiccFactorPair> {
  const configured = settings.usage.factors[family]
  const learned = await readCalibration().catch(() => null)
  return {
    input: Math.max(1, configured.input, learned?.[family].input ?? 1),
    output: Math.max(1, configured.output, learned?.[family].output ?? 1),
  }
}

/** Record an official count. The stored factor rises when the local count × factor fell short. */
export async function recordOfficialCount(family: LogiccTokenFamily, direction: 'input' | 'output', localCount: number, officialCount: number) {
  // Tiny samples are dominated by message framing and would distort the ratio.
  if (localCount < 50 || officialCount <= 0) return
  const needed = Math.min(MAX_FACTOR, Math.ceil((officialCount / localCount) * 1.02 * 10_000) / 10_000)
  await getDb()`INSERT INTO logicc_usage_calibration(family,direction,factor,samples) VALUES(${family},${direction},${Math.max(1, needed)},1)
    ON CONFLICT(family,direction) DO UPDATE SET factor=GREATEST(logicc_usage_calibration.factor,EXCLUDED.factor),
      samples=logicc_usage_calibration.samples+1,updated_at=now()`
  calibrationCache = undefined
}

const COUNT_TIMEOUT_MS = 4000
function anthropicCountUrl() { return (process.env.LOGICC_ANTHROPIC_COUNT_URL || 'https://api.anthropic.com/v1/messages/count_tokens') }
function geminiCountBase() { return (process.env.LOGICC_GEMINI_COUNT_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '') }

/**
 * The provider's own token count of `text`, from its free counting endpoint,
 * when a counting key is configured for the family. Failures return null.
 */
export async function officialCount(family: LogiccTokenFamily, text: string, settings: LogiccSettings, signal?: AbortSignal): Promise<number | null> {
  if (!text || (family !== 'claude' && family !== 'gemini')) return null
  const secrets = await getLogiccSecrets().catch(() => null)
  const timeout = AbortSignal.timeout(COUNT_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    if (family === 'claude' && secrets?.anthropicCountKey) {
      const response = await fetch(anthropicCountUrl(), {
        method: 'POST', signal: combined, redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-api-key': secrets.anthropicCountKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: settings.usage.anthropicCountModel, messages: [{ role: 'user', content: text }] }),
      })
      if (!response.ok) return null
      const value = Number(((await response.json()) as { input_tokens?: unknown }).input_tokens)
      return Number.isFinite(value) && value > 0 ? value : null
    }
    if (family === 'gemini' && secrets?.geminiCountKey) {
      const url = `${geminiCountBase()}/models/${encodeURIComponent(settings.usage.geminiCountModel)}:countTokens`
      const response = await fetch(url, {
        method: 'POST', signal: combined, redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': secrets.geminiCountKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }),
      })
      if (!response.ok) return null
      const value = Number(((await response.json()) as { totalTokens?: unknown }).totalTokens)
      return Number.isFinite(value) && value > 0 ? value : null
    }
  } catch { /* Counting is best-effort; the local estimate always applies. */ }
  return null
}

export interface UsageInput {
  family: LogiccTokenFamily
  /** Prompt string sent to Logicc. */
  prompt: string
  /** Results of Logicc's built-in tools that were fed back into the model. */
  toolResults: string[]
  /** Everything Logicc generated: text, reasoning and raw tool-call output. */
  output: string
  /** Official count of the prompt, when available. */
  officialPrompt?: number | null
  /** Usage Logicc reported itself, when it did. */
  reported?: { input: number; output: number } | null
}
/**
 * `usage` is exactly what clients and billing relays receive: the three
 * standard OpenAI fields. `source` and `detail` stay inside the platform
 * (request logs) so pricing internals never reach end customers.
 */
export interface ComputedUsage {
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  source: 'estimated' | 'upstream'
  detail: { family: LogiccTokenFamily; localPrompt: number; localOutput: number; factors: LogiccFactorPair; officialPrompt: number | null; reported: { input: number; output: number } | null }
}

export async function computeUsage(input: UsageInput, settings: LogiccSettings): Promise<ComputedUsage> {
  const factors = await effectiveFactors(input.family, settings)
  const localPrompt = localTokens(input.prompt) + input.toolResults.reduce((sum, text) => sum + localTokens(text), 0)
  const localOutput = localTokens(input.output)
  let promptTokens = Math.ceil(localPrompt * factors.input) + settings.usage.promptOverheadTokens
  if (input.officialPrompt) promptTokens = Math.max(promptTokens, input.officialPrompt + settings.usage.promptOverheadTokens)
  let completionTokens = Math.ceil(localOutput * factors.output) + settings.usage.completionOverheadTokens
  let source: ComputedUsage['source'] = 'estimated'
  if (input.reported && (input.reported.input >= promptTokens || input.reported.output >= completionTokens)) {
    promptTokens = Math.max(promptTokens, input.reported.input)
    completionTokens = Math.max(completionTokens, input.reported.output)
    source = 'upstream'
  }
  return {
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    source,
    detail: { family: input.family, localPrompt, localOutput, factors, officialPrompt: input.officialPrompt ?? null, reported: input.reported ?? null },
  }
}

/**
 * After a response: occasionally compare the output's official count with
 * the local one, so the output factor learns from real traffic. One sample
 * per family every 30 seconds keeps counting-endpoint use negligible.
 */
export async function calibrateOutputSample(family: LogiccTokenFamily, output: string, settings: LogiccSettings) {
  if (!settings.usage.autoCalibrate || (family !== 'claude' && family !== 'gemini')) return
  const local = localTokens(output)
  if (local < 50) return
  if (!await getRedis().set(`ccm:logicc:calibrate:${family}:output`, '1', 'EX', 30, 'NX')) return
  const official = await officialCount(family, output, settings)
  if (official) await recordOfficialCount(family, 'output', local, official)
}
