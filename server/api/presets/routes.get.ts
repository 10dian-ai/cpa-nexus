import { defineEventHandler } from 'h3'
import { listPresetBindings } from '../../lib/presets'
export default defineEventHandler(async () => ({ bindings: await listPresetBindings() }))
