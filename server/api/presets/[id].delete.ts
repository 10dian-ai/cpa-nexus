import { defineEventHandler, getRouterParam } from 'h3'
import { deletePreset } from '../../lib/presets'
export default defineEventHandler(event => deletePreset(getRouterParam(event, 'id') || ''))
