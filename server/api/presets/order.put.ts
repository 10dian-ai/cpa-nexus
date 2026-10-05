import { defineEventHandler } from 'h3'
import { reorderGroupPresets, reorderPresets } from '../../lib/presets'
import { orderSchema, readPresetBody } from '../../lib/presets/api'
export default defineEventHandler(async event => {
  const body = await readPresetBody(event, orderSchema)
  return { presets: body.groupId ? await reorderGroupPresets(body.groupId, body.ids) : await reorderPresets(body.ids) }
})
