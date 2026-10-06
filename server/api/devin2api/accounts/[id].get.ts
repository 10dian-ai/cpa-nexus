import { defineEventHandler, getRouterParam, createError } from 'h3'
import { accountIdSchema, validate } from '../../../lib/account-validation'
import { getDevinAccount } from '../../../lib/devin2api/admin'
export default defineEventHandler(async event => { const account = await getDevinAccount(validate(accountIdSchema, getRouterParam(event, 'id'))); if (!account) throw createError({ statusCode:404, message:'Devin 账号不存在' }); return account })
