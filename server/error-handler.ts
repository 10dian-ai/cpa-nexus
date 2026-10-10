import { send, setResponseHeaders, setResponseStatus, type H3Error, type H3Event } from 'h3'
import { redactLogValue } from '../shared/log-privacy'
import { redactPublicError } from './lib/error-privacy'

// Nitro's default error body/log includes the complete incoming URL. Build the
// public diagnostic here so that even parser and unhandled API errors obey the
// same policy before Nitro writes to the client or its application log.
export default function diagnosticErrorHandler(error: H3Error, event: H3Event) {
  redactPublicError(error)
  const sensitive = error.unhandled || error.fatal
  const statusCode = error.statusCode || 500
  const statusMessage = error.statusMessage || 'Server Error'
  if (sensitive) console.error('[request error]', error.message)
  setResponseHeaders(event, { 'content-type': 'application/json', 'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': "script-src 'none'; frame-ancestors 'none';" })
  setResponseStatus(event, statusCode, statusMessage)
  return send(event, JSON.stringify(redactLogValue({ error: true, url: '***', statusCode, statusMessage,
    message: sensitive ? 'Server Error' : error.message, data: sensitive ? undefined : error.data })))
}
