import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { z } from 'zod'
import { accountIdSchema, validate } from '../../../lib/account-validation'
import { patchDevinAccount } from '../../../lib/devin2api/admin'
import { accountConcurrencySchema } from '../../../lib/settings'
export default defineEventHandler(async event => { const id = validate(accountIdSchema, getRouterParam(event,'id')); const body = validate(z.object({ label:z.string().trim().min(1).max(200).optional(), token:z.string().max(20000).optional(), baseUrl:z.string().url().max(500).optional(), model:z.string().trim().max(200).optional(), proxy:z.string().max(500).optional(), enabled:z.boolean().optional(), maxConcurrency:accountConcurrencySchema.optional() }).strict().refine(value => Object.keys(value).length > 0, 'No account changes provided'), await readBody(event)); const account = await patchDevinAccount(id, body); if (!account) throw createError({ statusCode:404, message:'Devin 账号不存在' }); return account })
