import { createHmac, timingSafeEqual } from 'node:crypto'
import { getConfig } from './config'

const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/
export const ORIGINAL_KEY_ID_HEADER = 'x-nexus-original-key-id'
export const ORIGINAL_KEY_SIGNATURE_HEADER = 'x-nexus-original-key-signature'

export function signOriginalGatewayKey(keyId: string): string {
  if (!KEY_ID.test(keyId)) throw new Error('Invalid original gateway key identity')
  return createHmac('sha256', Buffer.from(getConfig().encryptionKey, 'base64'))
    .update('cpa-nexus:original-gateway-key:v1:').update(keyId).digest('base64url')
}

export function verifyOriginalGatewayKey(headers: Record<string, string | string[] | undefined>): string | null {
  const id = headers[ORIGINAL_KEY_ID_HEADER]
  const signature = headers[ORIGINAL_KEY_SIGNATURE_HEADER]
  if (typeof id !== 'string' || typeof signature !== 'string' || !KEY_ID.test(id) || !SIGNATURE.test(signature)) return null
  const expected = Buffer.from(signOriginalGatewayKey(id), 'base64url')
  const actual = Buffer.from(signature, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : null
}
