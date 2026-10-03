import { createError, defineEventHandler, readRawBody, setHeader } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '../../../lib/auth'
import { CpaClientError } from '../../../lib/cpa/client'
import { queryNativeQuota } from '../../../lib/cpa/quota'

const inputSchema = z.object({ auth_index: z.string().min(1).max(128), provider: z.string().trim().min(1).max(128) }).strict()
export default defineEventHandler(async event => {
  // Explicitly protect credential reads and supplier queries, in addition to the global /api admin middleware.
  await requireAdmin(event)
  setHeader(event, 'Cache-Control', 'no-store')
  const raw = await readRawBody(event)
  if (!raw) throw createError({ statusCode: 400, message: '请输入有效的配额查询参数' })
  let body: unknown
  try { body = JSON.parse(raw) } catch { throw createError({ statusCode: 400, message: '配额查询参数不是有效 JSON' }) }
  const parsed = inputSchema.safeParse(body)
  if (!parsed.success) throw createError({ statusCode: 400, message: '请选择凭据及配额提供方' })
  try { return await queryNativeQuota(parsed.data) }
  catch (error) {
    if (error instanceof CpaClientError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code, message: error.message } })
    throw createError({ statusCode: 502, message: '配额查询暂时无法完成，请稍后重试' })
  }
})
