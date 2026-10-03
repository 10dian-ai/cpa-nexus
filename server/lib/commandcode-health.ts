import { getOfficialCatalog } from './official-catalog'
/** Health reflects the last successful public Provider catalog check, not account authorization. */
export async function commandcodeProviderHealthy(): Promise<boolean> {
  try {
    const catalog = await getOfficialCatalog()
    const source = catalog.sources.find(item => item.id === 'provider-models')
    return !!source?.fetchedAt && !source.error && Date.now() - Date.parse(source.fetchedAt) < 10 * 60_000 &&
      catalog.models.some(model => model.providerAvailable && model.supportedEndpoints.length > 0)
  } catch { return false }
}
