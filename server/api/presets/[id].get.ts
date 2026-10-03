import { defineEventHandler, getRouterParam } from 'h3'
import { getPreset } from '../../lib/presets'
export default defineEventHandler(event => getPreset(getRouterParam(event, 'id') || ''))
