import { readRawBody, type H3Event } from 'h3'
import { z } from 'zod'
import { platformError } from '../platform-error'
import { validate } from '../account-validation'

export const createSchema = z.object({ name: z.string().min(1), description: z.string().optional(), sourceJson: z.union([z.string(), z.record(z.string(), z.unknown())]), variables: z.record(z.string(), z.string()).optional(), enabled: z.boolean().optional(), sortOrder: z.number().int().nonnegative().optional() }).strict()
export const updateSchema = createSchema.partial().refine(value => Object.keys(value).length > 0, '请提供需要修改的内容')
export const routeSchema = z.object({ keyId: z.string().uuid(), mode: z.enum(['inherit', 'bypass', 'preset', 'stack']), presetId: z.string().uuid().nullable().optional() }).strict()
export const orderSchema = z.object({ ids: z.array(z.string().uuid()), groupId: z.string().uuid().optional() }).strict()
export async function readPresetBody<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  const raw = await readRawBody(event)
  if (!raw) throw platformError({ statusCode: 400, message: '请求内容不能为空' })
  let input: unknown
  try { input = JSON.parse(raw) } catch { throw platformError({ statusCode: 400, message: '请求不是有效的 JSON' }) }
  return validate(schema, input)
}
