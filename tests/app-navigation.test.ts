import { describe, expect, it } from 'vitest'
import { buildNavigationGroups, navigationLinkMatches, selectCurrentNavigation } from '../app/composables/useAppNavigation'

describe('shell navigation', () => {
  it('keeps the CPA and CommandCode entry points grouped and module aware', () => {
    const groups = buildNavigationGroups([
      { id: 'commandcode', name: 'CommandCode', enabled: true, navigation: [], kind: 'extension', required: false, version: '1', description: '', capabilities: [], status: 'ready' },
      { id: 'devin2api', name: 'Devin', enabled: true, navigation: [{ to: '/devin2api', label: 'Devin', icon: 'i-ph-cube' }, { to: '/groups/accounts?module=devin2api', label: 'Devin 分组', icon: 'i-ph-users' }], kind: 'extension', required: false, version: '1', description: '', capabilities: [], status: 'ready' },
      { id: 'custom', name: 'Custom', enabled: true, navigation: [{ to: '/custom', label: 'Custom page', icon: 'i-ph-cube' }], kind: 'extension', required: false, version: '1', description: '', capabilities: [], status: 'ready' },
    ])
    expect(groups.map(group => group.label)).toEqual(['平台', 'CPA 内核', 'CommandCode', 'Devin', 'Custom'])
    expect(groups.find(group => group.label === 'CPA 内核')?.links.map(link => link.to)).toContain('/cpa/native')
    expect(groups.find(group => group.label === 'CommandCode')?.links.map(link => link.to)).toContain('/groups/accounts?module=commandcode')
    expect(groups.find(group => group.label === 'Devin')?.links.map(link => link.to)).toContain('/groups/accounts?module=devin2api')
  })

  it('keeps the extension entry points available while module metadata loads', () => {
    expect(buildNavigationGroups().map(group => group.label)).toContain('CommandCode')
    expect(buildNavigationGroups([{ id: 'commandcode', name: 'CommandCode', enabled: false, navigation: [], kind: 'extension', required: false, version: '1', description: '', capabilities: [], status: 'disabled' }]).map(group => group.label)).not.toContain('CommandCode')
  })

  it('selects query-specific pages over their parent page', () => {
    const groups = buildNavigationGroups()
    const current = selectCurrentNavigation(groups, '/cpa/plugins', { tab: 'store' })
    expect(current.to).toBe('/cpa/plugins?tab=store')
    expect(navigationLinkMatches('/groups/accounts?module=cpa', '/groups/accounts', { module: 'commandcode' })).toBe(false)
    expect(navigationLinkMatches('/groups/accounts?module=devin2api', '/groups/accounts', { module: 'devin2api' })).toBe(true)
    expect(navigationLinkMatches('/groups/accounts?module=cpa', '/groups/accounts', {})).toBe(true)
  })
})
