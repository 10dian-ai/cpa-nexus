import type { OfficialCatalogModel, OfficialCatalogView } from '../../../shared/official-catalog'
import { OfficialCatalogService } from './service'
import { postgresCatalogStore } from './store'
export { shouldRefresh, OFFICIAL_SOURCES } from './service'
export type { OfficialCatalogView, OfficialCatalogModel, OfficialCatalogPlan, OfficialEndpoint } from '../../../shared/official-catalog'
const service = new OfficialCatalogService(postgresCatalogStore)
export const getOfficialCatalog = () => service.getCatalog()
export const syncOfficialCatalog = (force = false) => service.sync(force)
export class OfficialCatalogUnavailableError extends Error {
  constructor() { super('官方 Provider 模型目录尚未同步，请刷新官方目录或等待后台同步'); this.name = 'OfficialCatalogUnavailableError' }
}
export function resolveProviderModel(catalog: OfficialCatalogView, id: string): OfficialCatalogModel | null {
  const model = catalog.models.find(model => model.id === id && model.providerAvailable && model.supportedEndpoints.length)
  if (model) return model
  if (!catalog.sources.some(source => source.id === 'provider-models' && source.fetchedAt)) throw new OfficialCatalogUnavailableError()
  return null
}
export async function getProviderModel(id: string): Promise<OfficialCatalogModel | null> {
  return resolveProviderModel(await getOfficialCatalog(), id)
}
