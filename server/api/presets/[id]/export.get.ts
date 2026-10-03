import { defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getPreset } from '../../../lib/presets'
export default defineEventHandler(async event => { const preset = await getPreset(getRouterParam(event, 'id') || ''); setHeader(event, 'Content-Disposition', `attachment; filename="preset-${preset.id}.json"`); return preset.sourceJson })
