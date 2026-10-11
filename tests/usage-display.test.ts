import { describe, expect, it } from 'vitest'
import { splitNexusUsage, usageTokens } from '../shared/usage'
import { BillingUsageObserver } from '../server/lib/billing'

describe('usage display helpers', () => {
  it('reads totals from every protocol shape', () => {
    expect(usageTokens({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({ input: 10, output: 5, total: 15 })
    expect(usageTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 })).toEqual({ input: 110, output: 5, total: 115 })
    expect(usageTokens({ promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 9 })).toEqual({ input: 3, output: 4, total: 9 })
    expect(usageTokens(null)).toEqual({})
  })

  it('separates the routing record from provider usage', () => {
    expect(splitNexusUsage({ input_tokens: 1, nexus: { groupId: 'g' } })).toEqual({ usage: { input_tokens: 1 }, route: { groupId: 'g' } })
    expect(splitNexusUsage({ nexus: { groupId: 'g' } }).usage).toBeNull()
  })

  it('observes Gemini usageMetadata in responses', () => {
    const observer = new BillingUsageObserver()
    observer.push(new TextEncoder().encode('{"candidates":[],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}'))
    observer.end()
    expect(observer.value()).toEqual({ promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 })
  })
})
