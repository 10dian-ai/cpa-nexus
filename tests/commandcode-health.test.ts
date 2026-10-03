import { describe,expect,it,vi } from 'vitest'
const fixture=vi.hoisted(()=>({catalog:vi.fn()}))
vi.mock('../server/lib/official-catalog',()=>({getOfficialCatalog:fixture.catalog}))
import { commandcodeProviderHealthy } from '../server/lib/commandcode-health'
describe('official Provider health uses cached verified metadata',()=>{
  it('checks fresh public API metadata without treating website-only records as API access',async()=>{
    fixture.catalog.mockResolvedValue({sources:[{id:'provider-models',fetchedAt:new Date().toISOString(),error:null}],models:[{providerAvailable:true,supportedEndpoints:['messages']}]})
    expect(await commandcodeProviderHealthy()).toBe(true)
    fixture.catalog.mockResolvedValue({sources:[{id:'provider-models',fetchedAt:new Date().toISOString(),error:null}],models:[{providerAvailable:false,supportedEndpoints:[]}]})
    expect(await commandcodeProviderHealthy()).toBe(false)
  })
  it('reports unavailable for old metadata, refresh failure and storage failures',async()=>{
    fixture.catalog.mockResolvedValue({sources:[{id:'provider-models',fetchedAt:new Date(Date.now()-11*60_000).toISOString(),error:null}],models:[{providerAvailable:true,supportedEndpoints:['chat/completions']}]})
    expect(await commandcodeProviderHealthy()).toBe(false)
    fixture.catalog.mockResolvedValue({sources:[{id:'provider-models',fetchedAt:new Date().toISOString(),error:'HTTP 503'}],models:[{providerAvailable:true,supportedEndpoints:['chat/completions']}]})
    expect(await commandcodeProviderHealthy()).toBe(false)
    fixture.catalog.mockRejectedValue(new Error('Database unavailable'))
    expect(await commandcodeProviderHealthy()).toBe(false)
  })
})
