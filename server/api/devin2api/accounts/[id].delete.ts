import { defineEventHandler, getRouterParam, createError } from 'h3'
import { accountIdSchema, validate } from '../../../lib/account-validation'
import { deleteDevinAccount } from '../../../lib/devin2api/admin'
export default defineEventHandler(async event => { const id = validate(accountIdSchema, getRouterParam(event,'id')); if (!await deleteDevinAccount(id)) throw createError({ statusCode:404, message:'Devin 账号不存在' }); return { deleted:true, id } })
