export type ModelModuleId = 'cpa' | 'commandcode'

export interface AuthenticatedModelKey {
  id: string
  name: string
  /** Older integrations without this field retain CommandCode access. */
  moduleId?: ModelModuleId
}
