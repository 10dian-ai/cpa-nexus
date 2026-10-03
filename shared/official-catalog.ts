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
}
