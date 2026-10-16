import { defineEventHandler } from 'h3'
import type { ServiceKey } from '../../../lib/auth'
import { intakeModuleViews } from '../../../lib/intake/request'

/** Modules this service key may add accounts to, with the formats each accepts. */
export default defineEventHandler(async event => {
  const key = event.context.serviceKey as ServiceKey
  return { key: { name: key.name }, modules: await intakeModuleViews(key.moduleIds) }
})
