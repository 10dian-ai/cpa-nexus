import { defineEventHandler, getQuery } from 'h3'
import { listPresets, listPresetSummaries } from '../../lib/presets'
import { isModuleEnabled } from '../../lib/modules'
export default defineEventHandler(async event => { const summary = getQuery(event).view === 'summary'; const [presets, moduleEnabled] = await Promise.all([summary ? listPresetSummaries() : listPresets(), isModuleEnabled('presets')]); return { presets, moduleEnabled } })
