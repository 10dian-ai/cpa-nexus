import { createError } from 'h3'
import { redactLogValue, redactSensitiveText } from '../../shared/log-privacy'
export function platformError(input: { statusCode: number; message: string; data?: Record<string, unknown> }) {
  const message = redactSensitiveText(input.message)
  return createError({ ...input, message, data: { ...redactLogValue(input.data), message } })
}
