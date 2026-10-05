import { defineEventHandler, getQuery } from 'h3'
import { listPresets, listPresetSummaries } from '../../lib/presets'
import { isModuleEnabled } from '../../lib/modules'
export default defineEventHandler(async event => {
  const query = getQuery(event), summary = query.view === 'summary'
  const groupId = typeof query.groupId === 'string' && query.groupId ? query.groupId : undefined
  const [presets, moduleEnabled] = await Promise.all([summary ? listPresetSummaries(groupId) : listPresets(groupId), isModuleEnabled('presets')])
  return { presets, moduleEnabled, ...(groupId ? { groupId } : {}) }
})
