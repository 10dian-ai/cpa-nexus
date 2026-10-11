import { defineEventHandler } from 'h3'
import { handleNexusInference } from '../../lib/cpa/inference'

// Gemini protocol entry for local development; production nginx rewrites to /nexus/cpa/v1beta.
export default defineEventHandler(handleNexusInference)
