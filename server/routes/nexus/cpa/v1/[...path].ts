import { defineEventHandler } from 'h3'
import { handleNexusInference } from '../../../../lib/cpa/inference'
export default defineEventHandler(handleNexusInference)
