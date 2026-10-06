import { defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { accountConcurrencySchema, setAccountPoolConcurrency } from '../../lib/settings'
import { publishUpdate } from '../../lib/events'

export default defineEventHandler(async event => {
  const { maxConcurrency } = validate(z.object({ maxConcurrency: accountConcurrencySchema }).strict(), await readBody(event))
  const result = await setAccountPoolConcurrency(maxConcurrency)
  await publishUpdate({ type: 'accounts' })
  await publishUpdate({ type: 'settings' })
  return result
})
