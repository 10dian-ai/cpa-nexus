import { defineEventHandler } from 'h3'
import { listKeyPresetBindings } from '../../lib/presets'
export default defineEventHandler(async () => ({ bindings: await listKeyPresetBindings() }))
