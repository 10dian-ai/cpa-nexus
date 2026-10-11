import type { AuthenticatedModelKey } from '../../../shared/keys'
import { listCpaGroupOffers } from '../cpa/group-routing'
import { listGatewayModels } from '../gateway/accounts'
import { isModuleEnabled } from '../modules'
import { publicModelName } from './model-names'

export interface PublicModel { id: string; object: 'model'; owned_by: string }

/**
 * The models a unified key may call, under their original names: no provider
 * namespace (`devin/`), source prefix or thinking suffix, each name once.
 */
export async function listKeyModels(key: AuthenticatedModelKey, groupIds: string[]): Promise<PublicModel[]> {
  const moduleId = key.moduleId || 'commandcode'
  const tasks: Array<Promise<PublicModel[]>> = []
  if (moduleId === 'cpa' || moduleId === 'auto') {
    tasks.push(listCpaGroupOffers(groupIds).then(offers => offers.flatMap(offer => offer.models.map(id => ({
      id: publicModelName(id, offer.prefix), object: 'model' as const, owned_by: offer.provider || 'cpa',
    })))))
  }
  if ((moduleId === 'commandcode' || moduleId === 'auto') && await isModuleEnabled('commandcode')) {
    tasks.push(listGatewayModels(key.id).then(result => result.data.map(model => ({ id: model.id, object: 'model' as const, owned_by: 'commandcode' }))))
  }
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
