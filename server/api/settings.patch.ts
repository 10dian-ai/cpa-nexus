import { defineEventHandler, readBody, createError } from 'h3'
import { saveSettings, settingsSchema } from '../lib/settings'
import { publishUpdate } from '../lib/events'
import { KERNEL_INFO } from './settings.get'
export default defineEventHandler(async event => {
  const parsed = settingsSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '设置值超出允许范围', data: parsed.error.flatten() })
  await saveSettings(parsed.data)
  await publishUpdate({ type: 'settings' })
  return { settings: parsed.data, kernel: KERNEL_INFO }
})
