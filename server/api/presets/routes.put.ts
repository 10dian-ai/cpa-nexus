import { defineEventHandler } from 'h3'
import { setPresetBinding } from '../../lib/presets'
import { readPresetBody, routeSchema } from '../../lib/presets/api'
export default defineEventHandler(async event => ({ binding: await setPresetBinding(await readPresetBody(event, routeSchema)) }))
