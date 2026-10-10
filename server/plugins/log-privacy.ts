import { redactDiagnosticFields, redactLogValue } from '../../shared/log-privacy'
import { redactPublicError } from '../lib/error-privacy'

export default defineNitroPlugin(app => {
  app.hooks.hook('error', error => { redactPublicError(error) })
  app.hooks.hook('beforeResponse', (event, response) => {
    // Covers stored account/job errors and local API failures. Raw model proxy
    // streams and CPA log downloads apply the same policy at their own write.
    if (!(response.body instanceof Uint8Array)) response.body = event.node.res.statusCode >= 400 ? redactLogValue(response.body) : redactDiagnosticFields(response.body)
  })
})
