/**
 * A model key may be unrestricted (`auto`) or bound to one extension
 * module.  `devin2api` is intentionally distinct from CPA's native Devin
 * provider: the latter still runs inside the CPA kernel while this module
 * fronts the standalone devin-2api adapter.
 */
export type ModelModuleId = 'auto' | 'cpa' | 'commandcode' | 'devin2api'

export interface AuthenticatedModelKey {
  id: string
  name: string
  /** Older integrations without this field retain CommandCode access. */
  moduleId?: ModelModuleId
}
