import { defineEventHandler, getQuery } from 'h3'
import { z } from 'zod'
import { listDevinLogs } from '../../lib/devin2api/admin'
import { validate } from '../../lib/account-validation'
export default defineEventHandler(event => listDevinLogs(validate(z.object({ page:z.coerce.number().int().min(1).max(100000).default(1), pageSize:z.coerce.number().int().min(1).max(200).default(50), model:z.string().max(200).optional(), status:z.enum(['','success','error','cancelled','incomplete']).optional() }), getQuery(event))))
