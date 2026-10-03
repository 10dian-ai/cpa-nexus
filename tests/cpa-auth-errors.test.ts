import { describe, expect, it } from 'vitest'
import { apiErrorMessage, isPlatformAuthenticationError } from '../app/composables/useApiAction'
describe('CPA errors preserve the independent platform session', () => {
  it('distinguishes an upstream credential rejection from an expired platform login', () => {
    expect(isPlatformAuthenticationError({ statusCode: 401, response: { headers: new Headers({ 'x-nexus-upstream': 'cpa' }) } })).toBe(false)
    expect(isPlatformAuthenticationError({ statusCode: 401, response: { headers: new Headers() } })).toBe(true)
    expect(isPlatformAuthenticationError(null)).toBe(false)
  })
  it('shows H3 local error data and native CPA error descriptions', () => {
    expect(apiErrorMessage({ data: { statusCode: 503, data: { message: '此模块已停用' } } })).toBe('此模块已停用')
    expect(apiErrorMessage({ data: { error: 'invalid_config' } })).toBe('invalid_config')
    expect(apiErrorMessage({ data: { error: { message: 'No model configured' } } })).toBe('No model configured')
  })
})
