import { defineEventHandler, readBody } from 'h3'
import { validate } from '../../lib/account-validation'
import { createGroup, groupInputSchema } from '../../lib/groups'
export default defineEventHandler(async event => createGroup(validate(groupInputSchema, await readBody(event))))
