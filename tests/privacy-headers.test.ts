import { describe, expect, it } from 'vitest'
import { privacyHeaders, privateSessionId } from '../server/lib/privacy-headers'
import { makeInternalBridgeHeaders, makeProviderHeaders } from '../server/lib/gateway/transport'

describe('default OpenCode identity at the supplier boundary', () => {
  const secret = 'test-only-private-session-secret'
  const original = {
    'User-Agent': 'claude-code/device-path', originator: 'codex_cli', cookie: 'private-browser-session',
    'x-claude-code-session-id': 'private-client-conversation', 'x-agent-id': 'private-parent-agent', 'x-subagent-id': 'private-child-agent',
    'x-stainless-os': 'private-os', 'x-stainless-package-version': 'private-sdk-version', 'x-opencode-project': 'private-local-path',
    'x-real-ip': '192.0.2.55', 'x-forwarded-for': '192.0.2.55', referer: 'https://private.example.invalid',
    traceparent: 'private-trace', 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
    'anthropic-version': '2023-06-01', 'openai-beta': 'responses=experimental', 'x-cmd-zdr': '1',
  }
  it('overrides software identity and strips original device, SDK, address and trace data', () => {
    const result = privacyHeaders(original, secret)
    expect(result).toMatchObject({ 'user-agent': 'opencode', originator: 'opencode', 'anthropic-version': '2023-06-01', 'openai-beta': 'responses=experimental', 'x-cmd-zdr': '1', 'anthropic-beta': 'interleaved-thinking-2025-05-14' })
    for (const key of ['cookie', 'x-stainless-os', 'x-stainless-package-version', 'x-opencode-project', 'x-real-ip', 'x-forwarded-for', 'referer', 'traceparent', 'x-claude-code-session-id']) expect(result[key]).toBeUndefined()
    expect(result['x-session-id']).toBe(privateSessionId('private-client-conversation', secret))
    expect(result['x-agent-id']).not.toBe('private-parent-agent')
    expect(result['x-subagent-id']).not.toBe('private-child-agent')
    expect(JSON.stringify(result)).not.toContain('private-')
  })
  it('keeps an opaque protocol turn state, and pseudonyms are stable without changing local hints', () => {
    const before = structuredClone(original)
    const first = privacyHeaders({ ...original, 'x-codex-turn-state': 'opaque-protocol-state' }, secret)
    const second = privacyHeaders(original, secret)
    expect(first['x-codex-turn-state']).toBe('opaque-protocol-state')
    expect(first['x-session-id']).toBe(second['x-session-id'])
    expect(privacyHeaders(original, 'different-secret')['x-session-id']).not.toBe(first['x-session-id'])
    expect(original).toEqual(before)
  })
  it('never forwards raw identifiers when no trusted pseudonym key is available', () => {
    const result = privacyHeaders(original)
    for (const name of ['x-session-id', 'x-agent-id', 'x-subagent-id']) expect(result[name]).toBeUndefined()
  })
  it('keeps internal affinity context inside the owned bridge but sanitizes the actual supplier request', () => {
    const local = makeInternalBridgeHeaders({ ...original, 'x-claude-code-session-id': 'private-client-conversation' }, 'local-core-key')
    expect(local.get('x-claude-code-session-id')).toBe('private-client-conversation')
    const external = makeProviderHeaders(original, 'synthetic-supplier-key', secret)
    expect(external.get('authorization')).toBe('Bearer synthetic-supplier-key')
    expect(external.get('user-agent')).toBe('opencode')
    expect(external.get('x-session-id')).toBe(privateSessionId('private-client-conversation', secret))
    expect(external.get('x-claude-code-session-id')).toBeNull()
    expect(external.get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14')
  })
})
