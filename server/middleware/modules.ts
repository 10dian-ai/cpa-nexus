import { defineEventHandler, getRequestURL } from 'h3'
import { gatedModuleForRequest } from '../../shared/modules'
import { requireModule } from '../lib/modules'
export default defineEventHandler(async event => {
  const id = gatedModuleForRequest(getRequestURL(event).pathname, event.method)
  if (id) await requireModule(id)
})
