import { createError, defineEventHandler } from 'h3'
import { listModels } from '../lib/accounts'
import { OfficialCatalogUnavailableError } from '../lib/official-catalog'

export default defineEventHandler(async () => {
  try {
    return await listModels()
  } catch (error) {
    // A cold deployment has no official model snapshot yet. Surface that
    // dependency state as a retryable service error instead of an opaque 500.
    if (error instanceof OfficialCatalogUnavailableError) {
      throw createError({
        statusCode: 503,
        statusMessage: error.message,
        message: error.message,
        data: { code: 'official_catalog_unavailable' },
      })
    }
    throw error
  }
})
