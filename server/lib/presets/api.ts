import { getHeader, readRawBody, type H3Event } from 'h3'
import { z } from 'zod'
import { platformError } from '../platform-error'
import { validate } from '../account-validation'
import { PRESET_MAX_BYTES } from '../../../shared/presets'

export const createSchema = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).optional(), sourceJson: z.union([z.string(), z.record(z.string(), z.unknown())]), variables: z.record(z.string(), z.string()).optional() }).strict()
export const updateSchema = createSchema.partial().refine(value => Object.keys(value).length > 0, '请提供需要修改的内容')
export const routeSchema = z.object({ moduleId: z.string().min(1).max(100), accountId: z.string().max(500).nullable().optional(), mode: z.enum(['inherit', 'bypass', 'preset']), presetId: z.string().uuid().nullable().optional() }).strict()
export async function readPresetBody<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  const declared = Number(getHeader(event, 'content-length'))
  if (declared > PRESET_MAX_BYTES * 3) throw platformError({ statusCode: 413, message: '预设请求过大' })
  const raw = await readRawBody(event)
  if (!raw || Buffer.byteLength(raw) > PRESET_MAX_BYTES * 3) throw platformError({ statusCode: raw ? 413 : 400, message: raw ? '预设请求过大' : '请求内容不能为空' })
  let input: unknown
  try { input = JSON.parse(raw) } catch { throw platformError({ statusCode: 400, message: '请求不是有效的 JSON' }) }
  return validate(schema, input)
}
