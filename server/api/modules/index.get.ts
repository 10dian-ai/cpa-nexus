import { defineEventHandler } from 'h3'
import { listModules } from '../../lib/modules'
export default defineEventHandler(async () => ({ modules: await listModules() }))
