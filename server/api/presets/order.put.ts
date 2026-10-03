import { defineEventHandler } from 'h3'
import { reorderPresets } from '../../lib/presets'
import { orderSchema, readPresetBody } from '../../lib/presets/api'
export default defineEventHandler(async event => ({ presets: await reorderPresets((await readPresetBody(event, orderSchema)).ids) }))
