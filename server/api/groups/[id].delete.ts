import { defineEventHandler, getRouterParam } from 'h3'
import { validate, accountIdSchema } from '../../lib/account-validation'
import { deleteGroup } from '../../lib/groups'
export default defineEventHandler(async event => { await deleteGroup(validate(accountIdSchema, getRouterParam(event, 'id'))); return { ok: true } })
