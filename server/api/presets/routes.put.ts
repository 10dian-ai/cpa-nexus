import { defineEventHandler } from 'h3'
import { setKeyPresetBinding } from '../../lib/presets'
import { readPresetBody, routeSchema } from '../../lib/presets/api'
export default defineEventHandler(async event => ({ binding: await setKeyPresetBinding(await readPresetBody(event, routeSchema)) }))
