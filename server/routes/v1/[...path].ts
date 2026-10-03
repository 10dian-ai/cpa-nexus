import { defineEventHandler } from 'h3'
import { handleGateway } from '../../lib/gateway/handler'
import { handleNexusInference } from '../../lib/cpa/inference'

export default defineEventHandler(event => {
  const authorization = event.node.req.headers.authorization
  const apiKey = event.node.req.headers['x-api-key']
  const secret = typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, '').trim() : typeof apiKey === 'string' ? apiKey.trim() : ''
  // The core returns to this address with its private bridge key. Public keys use the same entry in dev and production.
  return secret.startsWith('ccm_nexus_') ? handleGateway(event) : handleNexusInference(event)
})
