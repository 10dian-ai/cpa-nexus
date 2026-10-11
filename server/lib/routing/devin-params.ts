import { createCpaClient } from '../cpa/client'
import { levelFromBudget, normalizeThinkingLevel, stripProviderNamespace, type ThinkingLevel } from './model-names'

/**
 * Devin selects a separate upstream model for every thinking level
 * (`claude-opus-4-8-high`, `…-max`). CPA's native Devin provider takes the
 * level from a `(level)` suffix on `devin/<model>`; it ignores sampling and
 * thinking fields otherwise. Clients behind New API send standard reasoning
 * parameters instead, so CPAN converts them here before the request reaches
 * CPA:
 *   1. level from the model name (suffix) wins, then request parameters,
 *      then the configured default;
 *   2. the level is clamped to the levels CPA's Devin catalog lists;
 *   3. the consumed thinking fields are removed, and sampling controls are
 *      dropped for thinking levels (Devin's own CLI never sends them).
 */
type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)

export interface DevinParamOptions { defaultLevel: ThinkingLevel; stripSampling: boolean }
export interface DevinParamResult {
  body: JsonObject
  /** Model sent to CPA: `devin/<model>(<level>)`. */
  model: string
  level: ThinkingLevel
  /** Where the level came from, for request logs. */
  levelSource: 'model' | 'request' | 'default'
  removed: string[]
}

/** Read the requested thinking level from any supported protocol's fields. */
export function requestedThinkingLevel(body: JsonObject): ThinkingLevel | undefined {
  const reasoning = object(body.reasoning) ? body.reasoning : undefined
  const thinking = object(body.thinking) ? body.thinking : undefined
  const outputConfig = object(body.output_config) ? body.output_config : undefined
  const generation = object(body.generationConfig) ? body.generationConfig : object(body.generation_config) ? body.generation_config : undefined
  const thinkingConfig = generation && (object(generation.thinkingConfig) ? generation.thinkingConfig : object(generation.thinking_config) ? generation.thinking_config : undefined)
  const explicit = normalizeThinkingLevel(outputConfig?.effort) ?? normalizeThinkingLevel(body.reasoning_effort)
    ?? normalizeThinkingLevel(reasoning?.effort) ?? normalizeThinkingLevel(thinkingConfig?.thinkingLevel ?? thinkingConfig?.thinking_level)
  if (explicit) return explicit
  if (thinking) {
    const type = String(thinking.type || '').toLowerCase()
    if (type === 'disabled') return 'none'
    if (thinking.budget_tokens !== undefined) return levelFromBudget(thinking.budget_tokens)
  }
  if (reasoning && reasoning.enabled === false) return 'none'
  if (reasoning?.max_tokens !== undefined) return levelFromBudget(reasoning.max_tokens)
  const budget = thinkingConfig?.thinkingBudget ?? thinkingConfig?.thinking_budget
  if (budget !== undefined && Number(budget) >= 0) return levelFromBudget(budget)
  return undefined
}

const THINKING_FIELDS = ['reasoning_effort', 'reasoning', 'thinking', 'output_config.effort', 'generationConfig.thinkingConfig', 'generation_config.thinking_config']
const SAMPLING_FIELDS = ['temperature', 'top_p', 'top_k', 'generationConfig.temperature', 'generationConfig.topP', 'generationConfig.topK']

function removePath(body: JsonObject, path: string): boolean {
  const parts = path.split('.')
  let target: JsonObject = body
  for (const part of parts.slice(0, -1)) {
    if (!object(target[part])) return false
    target = target[part] = { ...(target[part] as JsonObject) }
  }
  const last = parts.at(-1)!
  if (!Object.hasOwn(target, last)) return false
  delete target[last]
  return true
}

/** Nearest supported level, preferring the higher one on a tie (as CPA does). */
export function clampLevel(level: ThinkingLevel, supported: string[] | undefined): ThinkingLevel {
  if (!supported?.length || supported.includes(level)) return level
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const wanted = order.indexOf(level)
  let best: string | undefined, distance = Infinity
  for (const candidate of supported) {
    const index = order.indexOf(candidate)
    if (index < 0) continue
    const current = Math.abs(index - wanted)
    if (current < distance || (current === distance && index > order.indexOf(best!))) { best = candidate; distance = current }
  }
  return (best as ThinkingLevel) || level
}

export function applyDevinParams(input: {
  body: JsonObject; nativeModel: string; nameLevel?: ThinkingLevel; supportedLevels?: string[]; options: DevinParamOptions
}): DevinParamResult {
  const body: JsonObject = { ...input.body }
  const fromRequest = requestedThinkingLevel(body)
  const levelSource: DevinParamResult['levelSource'] = input.nameLevel ? 'model' : fromRequest ? 'request' : 'default'
  const wanted = input.nameLevel || fromRequest || input.options.defaultLevel
  // Devin has no "off" variant for most models; CPA maps none to the default.
  const level = wanted === 'none' && input.supportedLevels?.length && !input.supportedLevels.includes('none')
    ? clampLevel(input.options.defaultLevel, input.supportedLevels) : clampLevel(wanted, input.supportedLevels)
  const removed = THINKING_FIELDS.filter(path => removePath(body, path))
  if (input.options.stripSampling && level !== 'none') removed.push(...SAMPLING_FIELDS.filter(path => removePath(body, path)))
  // A model the catalog lists without levels keeps its bare name unless the
  // client explicitly asked for a level (CPA maps e.g. sonnet-4-6 to -thinking).
  const bare = input.supportedLevels !== undefined && input.supportedLevels.length === 0 && levelSource === 'default'
  const model = bare ? input.nativeModel : `${input.nativeModel}(${level})`
  return { body, model, level, levelSource, removed }
}

export function isDevinModel(nativeModel: string) { return stripProviderNamespace(nativeModel).namespace === 'devin' }

let catalog: { until: number; value: Promise<Map<string, string[]>> } | undefined
export function resetDevinCatalog() { catalog = undefined }
/** Thinking levels of CPA's Devin catalog, keyed by `devin/<model>` (lower case). */
export async function devinThinkingLevels(): Promise<Map<string, string[]>> {
  if (catalog && catalog.until > Date.now()) return catalog.value
  const value = (async () => {
    const response = await createCpaClient().request({ path: 'routing/model-definitions/devin' })
    const result = new Map<string, string[]>()
    if (response.status !== 200) return result
    try {
      const payload = JSON.parse(new TextDecoder().decode(response.body)) as { models?: unknown }
      for (const model of Array.isArray(payload.models) ? payload.models : []) {
        if (!object(model) || typeof model.id !== 'string') continue
        const levels = object(model.thinking) && Array.isArray(model.thinking.levels) ? model.thinking.levels.filter((item): item is string => typeof item === 'string') : []
        result.set(model.id.toLowerCase(), levels)
      }
    } catch { /* An unreadable catalog only disables clamping. */ }
    return result
  })()
  catalog = { until: Date.now() + 300_000, value }
  value.catch(() => { if (catalog?.value === value) catalog = undefined })
  return value
}
