import { defineEventHandler } from 'h3'
import { listCpaPresetAccountRoutes } from '../../lib/cpa/preset-routing'
export default defineEventHandler(async () => ({ accounts: await listCpaPresetAccountRoutes({ fresh: true }) }))
