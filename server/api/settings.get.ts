import { defineEventHandler } from 'h3'
import { getSettings } from '../lib/settings'
export default defineEventHandler(async () => ({ settings: await getSettings() }))
