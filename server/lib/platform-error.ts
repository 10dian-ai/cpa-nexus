import { createError } from 'h3'
export function platformError(input: { statusCode: number; message: string; data?: Record<string, unknown> }) {
  return createError({ ...input, data: { ...input.data, message: input.message } })
}
