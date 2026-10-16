/**
 * Token usage arrives in each protocol's own shape (OpenAI `prompt_tokens`,
 * Anthropic/Responses `input_tokens`, Gemini `promptTokenCount`). Request logs
 * keep it as reported and add a `nexus` routing record; these helpers read it
 * consistently for display.
 */
type Usage = Record<string, unknown> | null | undefined
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const first = (usage: Record<string, unknown>, keys: string[]) => { for (const key of keys) { const value = number(usage[key]); if (value !== undefined) return value } return undefined }

export function usageTokens(usage: Usage): { input?: number; output?: number; total?: number } {
  if (!usage) return {}
  const input = first(usage, ['prompt_tokens', 'input_tokens', 'promptTokenCount', 'inputTokens'])
  const cached = (first(usage, ['cache_read_input_tokens']) ?? 0) + (first(usage, ['cache_creation_input_tokens']) ?? 0)
  const output = first(usage, ['completion_tokens', 'output_tokens', 'candidatesTokenCount', 'outputTokens'])
  const reported = first(usage, ['total_tokens', 'totalTokens', 'totalTokenCount'])
  const total = reported ?? (input !== undefined || output !== undefined ? (input ?? 0) + cached + (output ?? 0) : undefined)
  return { ...(input !== undefined ? { input: input + cached } : {}), ...(output !== undefined ? { output } : {}), ...(total !== undefined ? { total } : {}) }
}

export interface NexusRouteRecord {
  moduleId?: string; groupId?: string; groupIds?: string[]; strategy?: string; nativeModel?: string
  authIndex?: string; presetIds?: string[]; usageSource?: string; usageDetail?: Record<string, unknown>; devin?: { level?: string; source?: string; removed?: string[] }
  failover?: Array<{ kind?: string; moduleId?: string; groupId?: string; model?: string; status?: number; error?: string }>
}

/** Provider usage without the routing record, and the routing record itself. */
export function splitNexusUsage(usage: Usage): { usage: Record<string, unknown> | null; route: NexusRouteRecord | null } {
  if (!usage) return { usage: null, route: null }
  const { nexus, ...rest } = usage
  const route = nexus && typeof nexus === 'object' && !Array.isArray(nexus) ? nexus as NexusRouteRecord : null
  return { usage: Object.keys(rest).length ? rest : null, route }
}
