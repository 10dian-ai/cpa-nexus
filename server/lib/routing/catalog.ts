import type { AuthenticatedModelKey } from '../../../shared/keys'
import { listCpaGroupOffers } from '../cpa/group-routing'
import { enabledPoolModules, poolGroupModels, resolvePoolGroups } from './pool'
import { POOL_MODULE_ALIASES } from '../../../shared/modules'
import { publicModelName } from './model-names'

export interface PublicModel { id: string; object: 'model'; owned_by: string }

/** Models of every enabled pool module, under their own names, within the key's groups. */
async function poolModels(groupIds: string[]): Promise<PublicModel[]> {
  const result: PublicModel[] = []
  for (const moduleId of await enabledPoolModules()) {
    const served = await poolGroupModels(moduleId, groupIds)
    const ids = new Set<string>()
    for (const groupId of groupIds) for (const id of served.get(groupId) || []) ids.add(id)
    for (const id of ids) result.push({ id, object: 'model', owned_by: POOL_MODULE_ALIASES[moduleId] })
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
    listCpaGroupOffers(groupIds).then(offers => offers.flatMap(offer => offer.models.map(id => ({
      id: publicModelName(id, offer.prefix), object: 'model' as const, owned_by: offer.provider || 'cpa',
    })))),
  ]
  if (key.moduleId === 'auto') tasks.push(poolModels(groupIds))
  const results = await Promise.allSettled(tasks)
  if (results.length && results.every(result => result.status === 'rejected')) throw Object.assign(new Error('模型目录暂不可用'), { statusCode: 503 })
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
