/**
 * A model key may be unrestricted (`auto`: every source its groups can reach,
 * CPA credentials and module pools alike) or bound to CPA native sources only.
 * CPA's native providers, including Devin, belong to `cpa`.
 */
export type ModelModuleId = 'auto' | 'cpa'

export interface AuthenticatedModelKey {
  id: string
  name: string
  moduleId: ModelModuleId
}
