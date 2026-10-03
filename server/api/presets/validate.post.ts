import { defineEventHandler } from 'h3'
import { validatePreset } from '../../lib/presets'
import { createSchema, readPresetBody } from '../../lib/presets/api'
export default defineEventHandler(async event => validatePreset(await readPresetBody(event, createSchema)))
