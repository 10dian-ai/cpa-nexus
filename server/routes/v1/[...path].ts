import { defineEventHandler } from 'h3'
import { handleNexusInference } from '../../lib/cpa/inference'

// Every /v1 model request flows through the unified router: native CPA keys
// pass through, ccm_ keys get groups, presets, failover and pool-module
// bridges. Module bridge callbacks from CPA use /api/modules/*/bridge instead.
export default defineEventHandler(handleNexusInference)
