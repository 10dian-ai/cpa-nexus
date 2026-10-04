import { describe, expect, it } from 'vitest'
import { credentialGroupSource } from '../app/utils/cpa-credential-groups'
import type { GroupAccountView } from '../shared/groups'

const source = (sourceId: string, credentialIds: string[] = [], extra: Partial<GroupAccountView> = {}): GroupAccountView => ({
  id: sourceId, sourceId, sourceType: 'cpa', moduleId: 'cpa', name: 'Same visible account', provider: 'google',
  enabled: true, routingSupported: true, groupIds: ['group-a'], groupNames: ['CPA'], credentialIds, ...extra,
})

describe('CPA credential group inventory identities', () => {
  it('maps virtual children to their shared physical source with authoritative auth IDs', () => {
    const file = source('google-source.json', ['project-a-child', 'project-b-child'])
    const inventory = [file, source('another.json', ['other-child'])]
    expect(credentialGroupSource({ id: 'project-a-child', name: 'project-a', email: 'shared@example.invalid' }, inventory)).toBe(file)
    expect(credentialGroupSource({ id: 'project-b-child', name: 'project-b', runtime_only: true }, inventory)).toBe(file)
  })
  it('uses the physical path for virtual children without borrowing a visible name', () => {
    const file = source('google-source.json')
    expect(credentialGroupSource({ name: 'virtual-child', path: '/opt/cpa/auth/google-source.json' }, [file])).toBe(file)
    expect(credentialGroupSource({ name: 'virtual-child', path: 'D:\\auth\\google-source.json' }, [file])).toBe(file)
  })
  it('maps config and memory credentials through real inventory auth indices', () => {
    const configured = source('config:actual-index'), runtime = source('runtime:memory-index')
    expect(credentialGroupSource({ auth_index: 'actual-index', email: 'anything' }, [configured, runtime])).toBe(configured)
    expect(credentialGroupSource({ auth_index: 'memory-index' }, [configured, runtime])).toBe(runtime)
  })
  it('uses exact inventory IDs before auth-index and path fallback', () => {
    const real = source('physical.json', ['auth-id']), misleading = source('config:index')
    expect(credentialGroupSource({ id: 'auth-id', auth_index: 'index', path: '/auth/physical.json' }, [real, misleading])).toBe(real)
  })
  it('never infers a group from email, label, prefix or unknown identities', () => {
    const file = source('real.json', ['known-id'], { name: 'user@example.invalid' })
    expect(credentialGroupSource({ id: 'unknown', name: 'user@example.invalid', email: 'user@example.invalid', prefix: 'real.json' }, [file])).toBeNull()
    expect(credentialGroupSource({ name: 'real.json', source: 'memory' }, [file])).toBeNull()
    expect(credentialGroupSource({ name: 'real.json', source: 'file' }, [file])).toBe(file)
  })
  it('refuses missing sources and ambiguous real identities', () => {
    expect(credentialGroupSource({ id: 'id' }, [source('gone.json', ['id'], { missing: true })])).toBeNull()
    expect(credentialGroupSource({ id: 'shared' }, [source('a.json', ['shared']), source('b.json', ['shared'])])).toBeNull()
    expect(credentialGroupSource({ auth_index: 'duplicate' }, [source('config:duplicate'), source('runtime:duplicate')])).toBeNull()
  })
  it('does not match a CommandCode account masquerading as a CPA source', () => {
    expect(credentialGroupSource({ id: 'credential' }, [source('cc', ['credential'], { moduleId: 'commandcode' })])).toBeNull()
  })
})
