import { defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { validate } from '../../../lib/account-validation'
import { createDevinAccount } from '../../../lib/devin2api/admin'
import { accountConcurrencySchema } from '../../../lib/settings'
export default defineEventHandler(async event => createDevinAccount(validate(z.object({ label:z.string().trim().min(1).max(200), token:z.string().max(20000).optional(), baseUrl:z.string().url().max(500).optional(), model:z.string().trim().max(200).optional(), proxy:z.string().max(500).optional(), enabled:z.boolean().optional(), maxConcurrency:accountConcurrencySchema.optional() }).strict(), await readBody(event))))
