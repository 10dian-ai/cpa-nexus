/**
 * Model naming between clients (New API and friends) and CPA sources.
 *
 * Clients see and send each model's original name, e.g. `claude-opus-4-8`.
 * CPA sources may publish the same model under a provider namespace
 * (`devin/claude-opus-4-8`) or a per-source routing prefix. Older clients may
 * still send those forms, a CPA thinking suffix `model(high)`, or a Devin-style
 * effort suffix `model-high`; all of them keep working.
 */

/** Provider namespaces CPA puts in front of the original model name. */
export const NAMESPACED_PROVIDERS = ['devin'] as const
export const THINKING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]

export interface RequestedModel {
  /** Exactly what the client sent (trimmed). */
  raw: string
  /** Name without the CPA `(…)` thinking suffix. */
  name: string
  /** `(…)` suffix content, if any. */
  parenSuffix?: string
}

export function parseRequestedModel(raw: string): RequestedModel {
  const value = raw.trim()
  const match = /^(.*?)\(([^()]*)\)$/.exec(value)
  if (match && match[1]) return { raw: value, name: match[1], parenSuffix: match[2] }
  return { raw: value, name: value }
}

/** Remove a known provider namespace: `devin/x` → `x`. Other slashes are part of real names. */
export function stripProviderNamespace(id: string): { name: string; namespace?: string } {
  for (const namespace of NAMESPACED_PROVIDERS) {
    if (id.toLowerCase().startsWith(namespace + '/')) return { name: id.slice(namespace.length + 1), namespace }
  }
  return { name: id }
}

/** The client-facing original name of a native CPA model ID. */
export function publicModelName(id: string, sourcePrefix = ''): string {
  let value = id
  if (sourcePrefix && value.startsWith(sourcePrefix + '/')) value = value.slice(sourcePrefix.length + 1)
  return stripProviderNamespace(value).name
}

/** `claude-opus-4-8-high` → `{ base: 'claude-opus-4-8', level: 'high' }`. */
export function splitLevelSuffix(name: string): { base: string; level: ThinkingLevel } | null {
  const match = /^(.+)-(none|minimal|low|medium|high|xhigh|max)$/i.exec(name)
  return match ? { base: match[1]!, level: match[2]!.toLowerCase() as ThinkingLevel } : null
}

export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined
  const level = value.trim().toLowerCase()
  if ((THINKING_LEVELS as readonly string[]).includes(level)) return level as ThinkingLevel
  if (['off', 'disabled', 'disable'].includes(level)) return 'none'
  if (['auto', 'adaptive', 'enabled', 'on'].includes(level)) return undefined
  return undefined
}

/** Anthropic/Gemini token budgets → the Devin/CPA level scale. */
export function levelFromBudget(budget: unknown): ThinkingLevel | undefined {
  const value = Number(budget)
  if (!Number.isFinite(value)) return undefined
  if (value <= 0) return 'none'
  if (value <= 4096) return 'low'
  if (value <= 16384) return 'medium'
  if (value <= 32768) return 'high'
  return 'max'
}
