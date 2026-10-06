export const DEFAULT_GROUP_ID = '00000000-0000-4000-8000-000000000001'
/** Source module that owns an account/integration binding. */
export type GroupModuleId = 'commandcode' | 'cpa' | 'devin2api'
export interface GroupBinding { groupIds: string[]; groupNames: string[] }
export interface GroupView {
  id: string; name: string; description: string; enabled: boolean; isDefault: boolean
  accountCount: number; keyCount: number; createdAt: string; updatedAt: string
}
export type RoutingGroupView = GroupView
export interface GroupListView {
  items: RoutingGroupView[]
  defaultGroupId: string
  defaultGroupIds?: string[]
  moduleDefaultGroupIds?: Partial<Record<GroupModuleId, string>>
}
export interface GroupAccountView extends GroupBinding {
  id: string; moduleId: GroupModuleId; sourceType: string; sourceId: string
  name: string; provider: string; enabled: boolean
  routingSupported?: boolean; routingPrefix?: string; message?: string
  /** Actual native runtime owners, used to bind credentials to their stable physical source. */
  credentialIds?: string[]
  missing?: boolean
}
