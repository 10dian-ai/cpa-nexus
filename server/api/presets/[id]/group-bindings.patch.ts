import { defineEventHandler, getRouterParam } from 'h3'
import { z } from 'zod'
import { setGroupPresetBinding } from '../../../lib/presets'
import { readPresetBody } from '../../../lib/presets/api'

const schema = z.object({
  groupId: z.string().uuid(),
  enabled: z.boolean().nullable().optional(),
  sortOrder: z.number().int().nonnegative().nullable().optional(),
  sourceJson: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable().optional(),
  variables: z.record(z.string(), z.string()).nullable().optional(),
  reset: z.boolean().optional(),
}).strict()

export default defineEventHandler(async event => {
  const body = await readPresetBody(event, schema)
  return setGroupPresetBinding({ presetId: getRouterParam(event, 'id') || '', ...body })
})
