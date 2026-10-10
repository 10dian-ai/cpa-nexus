import { describe, expect, it } from 'vitest'
import { buildNavigationGroups, navigationLinkMatches, selectCurrentNavigation } from '../app/composables/useAppNavigation'

describe('shell navigation', () => {
  const view = (id: string, enabled: boolean, extra: Record<string, unknown> = {}) => ({ id, name: id, enabled, navigation: [], kind: 'extension', tier: 'module', icon: 'i-ph-cube-bold', required: false, version: '1', description: '', capabilities: [], status: enabled ? 'ready' : 'disabled', ...extra }) as never

  it('orders sections by the platform hierarchy: platform, CPA kernel, SillyTavern kernel, modules', () => {
    const groups = buildNavigationGroups([
      view('commandcode', true), view('devin2api', true), view('presets', true),
      view('custom', true, { name: 'Custom', navigation: [{ to: '/custom', label: 'Custom page', icon: 'i-ph-cube' }] }),
    ])
    expect(groups.map(group => group.label)).toEqual(['平台', 'CPA 内核 · 一级', '酒馆内核 · 二级', 'CommandCode 模块', 'Devin 模块', 'Custom'])
    const links = (label: string) => groups.find(group => group.label === label)?.links.map(link => link.to) || []
    expect(links('平台')).toEqual(['/', '/modules', '/keys', '/groups'])
    expect(links('CPA 内核 · 一级')).toContain('/cpa/native')
    expect(links('CPA 内核 · 一级')).toContain('/groups/accounts?module=cpa')
    expect(links('酒馆内核 · 二级')).toEqual(['/presets'])
    expect(links('CommandCode 模块')).toContain('/groups/accounts?module=commandcode')
    expect(links('Devin 模块')).toContain('/groups/accounts?module=devin2api')
  })

  it('places enabled CPA plugin pages directly under the CPA kernel', () => {
    const groups = buildNavigationGroups([], [{ id: 'fixture', name: 'Fixture', effectiveEnabled: true, menus: [{ path: '/v0/resource/plugins/fixture/index.html', name: 'Fixture page' }] }])
    expect(groups.map(group => group.label).slice(0, 3)).toEqual(['平台', 'CPA 内核 · 一级', 'CPA 插件页面'])
  })

  it('keeps default-on modules visible while module metadata loads and hides disabled ones', () => {
    const loading = buildNavigationGroups().map(group => group.label)
    expect(loading).toContain('CommandCode 模块')
    expect(loading).not.toContain('Devin 模块')
    expect(loading).not.toContain('酒馆内核 · 二级')
    const disabled = buildNavigationGroups([view('commandcode', false), view('presets', false)]).map(group => group.label)
    expect(disabled).not.toContain('CommandCode 模块')
    expect(disabled).not.toContain('酒馆内核 · 二级')
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
