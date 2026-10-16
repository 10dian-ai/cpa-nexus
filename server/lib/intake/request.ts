import type { H3Event } from 'h3'
import { createError } from 'h3'
import { z } from 'zod'
import { readJsonBodyLimited } from '../http/transport'
import { submitIntake } from '../queues'
import { intakeHandler, intakeHandlers } from '../../modules/registry'
import { isModuleEnabled } from '../modules'
import type { IntakeModuleId, IntakeModuleView, IntakeRequest, IntakeSubmitResult } from '../../../shared/intake'

/** Largest intake submission accepted in one request (pasted text, files and items together). */
export const INTAKE_BODY_LIMIT = 32 * 1024 * 1024

const intakeSchema = z.object({
  text: z.string().optional(),
  files: z.array(z.object({ name: z.string().max(255).default(''), content: z.string() }).strict()).max(500).optional(),
  items: z.array(z.unknown()).max(20_000).optional(),
  groupIds: z.array(z.string().uuid()).max(50).optional(),
}).strict().refine(value => !!(value.text?.trim() || value.files?.length || value.items?.length), '请提供要导入的账号：粘贴文本、上传文件或结构化条目')

export async function readIntakeRequest(event: H3Event): Promise<IntakeRequest> {
  const body = await readJsonBodyLimited(event, INTAKE_BODY_LIMIT)
  const parsed = intakeSchema.safeParse(body)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message || '导入内容格式不正确' })
  return parsed.data as IntakeRequest
}

/** Parse and queue a submission; nothing is queued when no entry is usable. */
export async function submitModuleIntake(moduleId: IntakeModuleId, request: IntakeRequest): Promise<IntakeSubmitResult> {
  if (request.groupIds?.length) {
    const { assertGroupIds } = await import('../groups')
    await assertGroupIds(request.groupIds)
  }
  return submitIntake(moduleId, request)
}

/** Modules the caller may add accounts to, each with the formats it accepts. */
export async function intakeModuleViews(allowed?: readonly IntakeModuleId[]): Promise<IntakeModuleView[]> {
  const handlers = intakeHandlers().filter(handler => !allowed || allowed.includes(handler.id))
  return Promise.all(handlers.map(async handler => ({ ...handler.describe(), enabled: await isModuleEnabled(handler.id) })))
}

export { intakeHandler }
