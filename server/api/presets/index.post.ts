import { defineEventHandler, setResponseStatus } from 'h3'
import { createPreset } from '../../lib/presets'
import { createSchema, readPresetBody } from '../../lib/presets/api'
export default defineEventHandler(async event => { const preset = await createPreset(await readPresetBody(event, createSchema)); setResponseStatus(event, 201); return preset })
