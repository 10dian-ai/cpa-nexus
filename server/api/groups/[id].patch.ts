import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { validate, accountIdSchema } from '../../lib/account-validation'
import { patchGroup, groupInputSchema } from '../../lib/groups'
export default defineEventHandler(async event => patchGroup(validate(accountIdSchema, getRouterParam(event, 'id')),
  validate(groupInputSchema.partial().refine(value => Object.keys(value).length > 0), await readBody(event))))
