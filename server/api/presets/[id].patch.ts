import { defineEventHandler, getRouterParam } from 'h3'
import { updatePreset } from '../../lib/presets'
import { updateSchema, readPresetBody } from '../../lib/presets/api'
export default defineEventHandler(async event => updatePreset(getRouterParam(event, 'id') || '', await readPresetBody(event, updateSchema)))
