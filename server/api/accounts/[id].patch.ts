import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { z } from 'zod'
import { validate,accountIdSchema } from '../../lib/account-validation'
import { patchAccount } from '../../lib/accounts'
import { groupIdsSchema } from '../../lib/groups'
import { accountConcurrencySchema } from '../../lib/settings'
export default defineEventHandler(async event=>{
  const id=validate(accountIdSchema,getRouterParam(event,'id'))
  const body=validate(z.object({label:z.string().trim().max(200).optional(),groupName:z.string().trim().max(100).optional(),groupIds:groupIdsSchema.optional(),note:z.string().max(5000).optional(),enabled:z.boolean().optional(),maxConcurrency:accountConcurrencySchema.optional()}).strict().refine(value=>Object.keys(value).length>0,'No account changes provided'),await readBody(event))
  const account=await patchAccount(id,body)
  if(!account)throw createError({statusCode:404,statusMessage:'Account not found'})
  return account
})
