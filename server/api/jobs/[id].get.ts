import { defineEventHandler, getRouterParam } from 'h3'
import { getIntakeJobView } from '../../lib/queues'

/** Progress of an account import job (admin). */
export default defineEventHandler(event => getIntakeJobView(getRouterParam(event, 'id') || ''))
