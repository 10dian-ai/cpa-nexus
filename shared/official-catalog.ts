export type OfficialEndpoint = 'chat/completions' | 'messages' | 'responses' | 'systemone'
export interface OfficialPlanAccess {
  included: boolean | null
  apiAccess: boolean | null
  allowanceUsd: number | null
  paygEligible: boolean | null
  source: string | null
  apiSource: string | null
  allowanceSource: string | null
  paygSource: string | null
  checkedAt: string | null
}
export interface OfficialCatalogModel {
  id: string
  name: string
  providerAvailable: boolean
  /** Membership in the live public /models JSON list; documented special endpoints are separate. */
  apiCatalogListed?: boolean
  apiDocumented?: boolean
  supportedEndpoints: OfficialEndpoint[]
  contextLength: number | null
  minPlanName: string | null
  vendor: string | null
  category: string | null
  planAccess: Record<string, OfficialPlanAccess>
  sources: string[]
}
export interface OfficialCatalogPlan {
  id: string
  name: string
  price: string | null
  credits: string | null
  modelDescription: string | null
  apiAccess: boolean | null
  apiSource: string | null
  includedModelCount: number | null
  scope: 'explicit' | 'all' | 'unknown'
  source: string
  checkedAt: string
}
export interface OfficialCatalogSource {
  id: string
  url: string
  fetchedAt: string | null
  lastAttemptAt: string | null
  etag: string | null
  lastModified: string | null
  error: string | null
  modelCount: number | null
}
export interface OfficialCatalogView {
  models: OfficialCatalogModel[]
  plans: OfficialCatalogPlan[]
  fetchedAt: string | null
  lastAttemptAt: string | null
  stale: boolean
  error: string | null
  sources: OfficialCatalogSource[]
  /** Another process owns the refresh lock; this response is a last good snapshot, not a completed refresh. */
  refreshInProgress?: boolean
  /** Present on a manual refresh response; source errors remain in the catalog's own status. */
  availabilitySync?: { updatedAt: string; modelCount: number; bridgeUpdated: boolean; bridgeError: string | null }
}

/** Subscription membership comes only from exact IDs in the official plan scope. */
export function isProviderModelForPlan(model: OfficialCatalogModel, planId = 'goat'): boolean {
  const access = model.planAccess[planId]
  return model.providerAvailable && model.supportedEndpoints.length > 0 && access?.included === true && access.apiAccess === true
}

/** Unknown billing IDs retain a conservative GOAT scope without claiming a known subscription. */
export function commandcodePlanScope(planId: string | null | undefined, knownPlanIds: string[]): { id: string; confirmed: boolean } {
  const normalized = planId?.trim().toLowerCase() || ''
  const aliases = new Map(knownPlanIds.flatMap(id => [[id, id], [`individual-${id}`, id]] as [string, string][]))
  const id = aliases.get(normalized)
  return id ? { id, confirmed: true } : { id: 'goat', confirmed: false }
}
