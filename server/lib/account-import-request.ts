import { z } from 'zod'
import { validate } from './account-validation'
import { queueImport } from './queues'
import { groupIdsSchema, assertGroupIds } from './groups'

const importBodySchema = z.object({
  text: z.string().min(1),
  groupName: z.string().trim().max(100).optional(),
  groupIds: groupIdsSchema.optional(),
}).strict()

const singleLine = () => z.string().min(1).refine(value => !/[\r\n]/.test(value), 'Provide a single line')
const externalImportBodySchema = z.object({
  text: z.string().min(1).optional(),
  token: singleLine().optional(),
  cookie: singleLine().optional(),
  groupName: z.string().trim().max(100).optional(),
  groupIds: groupIdsSchema.optional(),
}).strict().refine(body => [body.text, body.token, body.cookie].filter(value => value !== undefined).length === 1, {
  message: 'Provide exactly one of text, token or cookie',
})

export async function submitAccountImport(input: unknown) {
  const body = validate(importBodySchema, input)
  if (body.groupIds !== undefined) await assertGroupIds(body.groupIds)
  return body.groupIds === undefined ? queueImport(body.text, body.groupName) : queueImport(body.text, body.groupName, body.groupIds)
}

export async function submitExternalAccountImport(input: unknown) {
  const body = validate(externalImportBodySchema, input)
  return submitAccountImport({ text: body.text ?? body.token ?? body.cookie, groupName: body.groupName, groupIds: body.groupIds })
}
