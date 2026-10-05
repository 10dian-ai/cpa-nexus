import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { getGroupPreset, getPreset } from '../../lib/presets'
export default defineEventHandler(event => {
  const id = getRouterParam(event, 'id') || '', groupId = getQuery(event).groupId
  return typeof groupId === 'string' && groupId ? getGroupPreset(groupId, id) : getPreset(id)
})
