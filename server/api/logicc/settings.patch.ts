import { createError, defineEventHandler, readBody } from 'h3'
import { ZodError } from 'zod'
import { publishUpdate } from '../../lib/events'
import { saveLogiccSettings } from '../../modules/logicc/settings'

/** Body: `{ settings, secrets? }`. Secrets are write-only; `null` clears one. */
export default defineEventHandler(async event => {
  const body = await readBody(event) as { settings?: unknown; secrets?: unknown } | null
  try {
    const settings = await saveLogiccSettings(body?.settings, body?.secrets ?? {})
    await publishUpdate({ type: 'settings' })
    return { settings }
  } catch (error) {
    if (error instanceof ZodError) throw createError({ statusCode: 400, statusMessage: '设置值超出允许范围：' + (error.issues[0]?.path.join('.') || '') })
    throw error
  }
})
