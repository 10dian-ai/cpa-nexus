import { defineEventHandler, getQuery, getRouterParam, setHeader } from 'h3'
import { getGroupPreset, getPreset } from '../../../lib/presets'
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id') || ''
  const groupId = getQuery(event).groupId
  const preset = typeof groupId === 'string' && groupId ? await getGroupPreset(groupId, id) : await getPreset(id)
  setHeader(event, 'Content-Disposition', `attachment; filename="preset-${preset.id}.json"`)
  return preset.sourceJson
})
