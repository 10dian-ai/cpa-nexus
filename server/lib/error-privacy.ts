import { redactLogValue, redactSensitiveText } from '../../shared/log-privacy'

export function redactPublicError(error: Error) {
  error.message = redactSensitiveText(error.message)
  if (error.stack) error.stack = redactSensitiveText(error.stack)
  const h3 = error as Error & { statusMessage?: string; data?: unknown }
  if (h3.statusMessage) h3.statusMessage = redactSensitiveText(h3.statusMessage)
  if (h3.data !== undefined) h3.data = redactLogValue(h3.data)
}
