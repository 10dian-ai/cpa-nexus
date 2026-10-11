/**
 * A model key may be unrestricted (`auto`) or bound to one source module.
 * CPA's native providers, including Devin, belong to `cpa`.
 */
export type ModelModuleId = 'auto' | 'cpa' | 'commandcode'

export interface AuthenticatedModelKey {
  id: string
  name: string
  /** Older integrations without this field retain CommandCode access. */
  moduleId?: ModelModuleId
}
