import { defineEventHandler } from 'h3'
import { listGroups, getModuleDefaultGroupIds } from '../../lib/groups'
import { DEFAULT_GROUP_ID } from '../../../shared/groups'
export default defineEventHandler(async () => {
  const [items, moduleDefaultGroupIds] = await Promise.all([listGroups(), getModuleDefaultGroupIds()])
  return { items, defaultGroupId: DEFAULT_GROUP_ID, defaultGroupIds: [...new Set(Object.values(moduleDefaultGroupIds))], moduleDefaultGroupIds }
})
