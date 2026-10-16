import type { AuthenticatedModelKey } from '../../../shared/keys'
import { listCpaGroupOffers } from '../cpa/group-routing'
import { enabledPoolModules, poolGroupModels, resolvePoolGroups } from './pool'
import { publicModelName } from './model-names'

export interface PublicModel { id: string; object: 'model'; owned_by: string }

/**
 * `owned_by` names the model's vendor, as OpenAI does, never the channel
 * serving it (a pool module or a CPA provider integration).
 */
export function modelVendor(id: string): string {
  const name = id.toLowerCase().replace(/^[^/]*\//, '')
  if (/^(?:gpt|o\d|chatgpt|codex|dall-e|whisper|tts|text-embedding|davinci|babbage|omni)/.test(name)) return 'openai'
  if (/^claude/.test(name)) return 'anthropic'
  if (/^(?:gemini|gemma|imagen|veo|learnlm)/.test(name)) return 'google'
  if (/^grok/.test(name)) return 'xai'
  if (/^(?:deepseek)/.test(name)) return 'deepseek'
  if (/^(?:qwen|qwq|qvq)/.test(name)) return 'qwen'
  if (/^(?:kimi|moonshot)/.test(name)) return 'moonshot'
  if (/^(?:glm|chatglm)/.test(name)) return 'zhipu'
  if (/^(?:llama|meta-)/.test(name)) return 'meta'
  if (/^(?:mistral|mixtral|codestral|magistral|devstral)/.test(name)) return 'mistral'
  if (/^minimax/.test(name)) return 'minimax'
  return 'system'
}

/** Models of every enabled pool module, under their own names, within the key's groups. */
async function poolModels(groupIds: string[]): Promise<PublicModel[]> {
  const result: PublicModel[] = []
  for (const moduleId of await enabledPoolModules()) {
    const served = await poolGroupModels(moduleId, groupIds)
    const ids = new Set<string>()
    for (const groupId of groupIds) for (const id of served.get(groupId) || []) ids.add(id)
    for (const id of ids) result.push({ id, object: 'model', owned_by: modelVendor(id) })
  }
  return result
}

/**
 * The models a unified key may call, under their original names: no provider
 * namespace (`devin/`), source prefix or thinking suffix, each name once.
 * Includes CPA credential sources and, for `auto` keys, enabled pool modules.
 */
export async function listKeyModels(key: AuthenticatedModelKey, groupIds: string[]): Promise<PublicModel[]> {
  const tasks: Array<Promise<PublicModel[]>> = [
    listCpaGroupOffers(groupIds).then(offers => offers.flatMap(offer => offer.models.map(id => {
      const name = publicModelName(id, offer.prefix)
      return { id: name, object: 'model' as const, owned_by: modelVendor(name) }
    }))),
  ]
  if (key.moduleId === 'auto') tasks.push(poolModels(groupIds))
  const results = await Promise.allSettled(tasks)
  if (results.length && results.every(result => result.status === 'rejected')) throw Object.assign(new Error('The model list is temporarily unavailable'), { statusCode: 503 })
  const models = new Map<string, PublicModel>()
  for (const result of results) if (result.status === 'fulfilled') for (const model of result.value) if (!models.has(model.id)) models.set(model.id, model)
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Gemini `models.list` shape for `/v1beta/models`. */
export function geminiModelList(models: PublicModel[]) {
  return {
    models: models.map(model => ({
      name: 'models/' + model.id, baseModelId: model.id, version: '001', displayName: model.id,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    })),
  }
}
export { resolvePoolGroups }
