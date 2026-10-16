import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ offers: vi.fn() }))
vi.mock('../server/lib/cpa/group-routing', () => ({ listCpaGroupOffers: fixture.offers }))
import { orderGroups, planCpaRoute, resetGlobalModelCache, sequenceAttempts } from '../server/lib/routing/plan'
import { parseRequestedModel, publicModelName, splitLevelSuffix } from '../server/lib/routing/model-names'
import { applyDevinParams, clampLevel, requestedThinkingLevel } from '../server/lib/routing/devin-params'
import { errorMessageFrom, isFailoverResponse } from '../server/lib/routing/failover'
import { StreamOutcome } from '../server/lib/routing/stream-outcome'

const offer = (groupId: string, sourceId: string, models: string[], extra: Record<string, unknown> = {}) => ({ groupId, sourceId, provider: 'fixture', prefix: '', authIds: [sourceId + '-auth'], models, ...extra })

describe('model names', () => {
  it('shows original names without provider namespaces or source prefixes', () => {
    expect(publicModelName('devin/claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(publicModelName('team-a/gpt-5-5', 'team-a')).toBe('gpt-5-5')
    expect(publicModelName('vendor/model')).toBe('vendor/model')
    expect(parseRequestedModel('gpt-5-5(high)')).toEqual({ raw: 'gpt-5-5(high)', name: 'gpt-5-5', parenSuffix: 'high' })
    expect(splitLevelSuffix('claude-opus-4-8-xhigh')).toEqual({ base: 'claude-opus-4-8', level: 'xhigh' })
    expect(splitLevelSuffix('claude-opus-4-8')).toBeNull()
  })
})

describe('Devin parameter conversion', () => {
  const options = { defaultLevel: 'high' as const, stripSampling: true }
  it('reads the level from every supported protocol', () => {
    expect(requestedThinkingLevel({ reasoning_effort: 'low' })).toBe('low')
    expect(requestedThinkingLevel({ reasoning: { effort: 'max' } })).toBe('max')
    expect(requestedThinkingLevel({ output_config: { effort: 'medium' } })).toBe('medium')
    expect(requestedThinkingLevel({ thinking: { type: 'enabled', budget_tokens: 32000 } })).toBe('high')
    expect(requestedThinkingLevel({ thinking: { type: 'disabled' } })).toBe('none')
    expect(requestedThinkingLevel({ generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } })).toBe('low')
    expect(requestedThinkingLevel({ messages: [] })).toBeUndefined()
  })

  it('moves the level into the CPA model suffix and removes fields Devin rejects', () => {
    const result = applyDevinParams({ body: { model: 'x', reasoning_effort: 'max', temperature: 0.2, top_p: 0.9, messages: [] }, nativeModel: 'devin/claude-opus-4-8', supportedLevels: ['low', 'medium', 'high', 'max'], options })
    expect(result.model).toBe('devin/claude-opus-4-8(max)')
    expect(result.levelSource).toBe('request')
    expect(result.body).toEqual({ model: 'x', messages: [] })
    expect(result.removed).toEqual(expect.arrayContaining(['reasoning_effort', 'temperature', 'top_p']))
  })

  it('prefers the level in the model name, clamps to the catalog and falls back to the default', () => {
    expect(applyDevinParams({ body: { reasoning_effort: 'low' }, nativeModel: 'devin/m', nameLevel: 'xhigh', supportedLevels: ['low', 'high', 'max'], options }).model).toBe('devin/m(max)')
    expect(applyDevinParams({ body: {}, nativeModel: 'devin/m', supportedLevels: ['low', 'medium'], options }).model).toBe('devin/m(medium)')
    expect(applyDevinParams({ body: {}, nativeModel: 'devin/plain', supportedLevels: [], options }).model).toBe('devin/plain')
    expect(applyDevinParams({ body: { thinking: { type: 'disabled' } }, nativeModel: 'devin/m', supportedLevels: ['low', 'high'], options }).model).toBe('devin/m(high)')
    expect(clampLevel('medium', ['low', 'high'])).toBe('high')
  })

  it('keeps sampling controls when stripping is disabled or thinking is off', () => {
    expect(applyDevinParams({ body: { temperature: 0.5 }, nativeModel: 'devin/m', options: { defaultLevel: 'high', stripSampling: false } }).body).toEqual({ temperature: 0.5 })
    expect(applyDevinParams({ body: { temperature: 0.5, reasoning_effort: 'none' }, nativeModel: 'devin/m', supportedLevels: ['none', 'high'], options }).body).toEqual({ temperature: 0.5 })
  })
})

describe('route planning', () => {
  beforeEach(() => { fixture.offers.mockReset(); resetGlobalModelCache(); vi.stubEnv('CPA_CLIENT_KEY', '') })

  it('matches original names to native IDs inside each group only', async () => {
    fixture.offers.mockResolvedValue([
      offer('a', 'devin-a', ['devin/claude-opus-4-8', 'devin/gpt-5-5']),
      offer('b', 'claude-b', ['claude-opus-4-8']),
      offer('c', 'other-c', ['gemini-3-pro']),
    ])
    const plan = await planCpaRoute({ model: 'claude-opus-4-8', groupIds: ['a', 'b', 'c'] })
    expect([...plan.perGroup.keys()]).toEqual(['a', 'b'])
    expect(plan.perGroup.get('a')![0]).toMatchObject({ nativeModel: 'devin/claude-opus-4-8', allowedAuthIDs: ['devin-a-auth'] })
    expect(plan.perGroup.get('b')![0]).toMatchObject({ nativeModel: 'claude-opus-4-8', allowedAuthIDs: ['claude-b-auth'] })
  })

  it('accepts legacy namespaced, suffixed and parenthesized names', async () => {
    fixture.offers.mockResolvedValue([offer('a', 'devin-a', ['devin/claude-opus-4-8'])])
    expect((await planCpaRoute({ model: 'devin/claude-opus-4-8', groupIds: ['a'] })).perGroup.get('a')![0]!.nativeModel).toBe('devin/claude-opus-4-8')
    expect((await planCpaRoute({ model: 'claude-opus-4-8-high', groupIds: ['a'] })).perGroup.get('a')![0]).toMatchObject({ nativeModel: 'devin/claude-opus-4-8', nameLevel: 'high' })
    expect((await planCpaRoute({ model: 'claude-opus-4-8(max)', groupIds: ['a'] })).perGroup.get('a')![0]).toMatchObject({ parenSuffix: 'max' })
    expect((await planCpaRoute({ model: 'claude-opus-4-9', groupIds: ['a'] })).perGroup.size).toBe(0)
  })

  it('prefers an exact native ID over a level-suffix interpretation', async () => {
    fixture.offers.mockResolvedValue([offer('a', 'native', ['gpt-5-5-high']), offer('a', 'devin', ['devin/gpt-5-5'])])
    const attempts = (await planCpaRoute({ model: 'gpt-5-5-high', groupIds: ['a'] })).perGroup.get('a')!
    expect(attempts.map(item => item.nativeModel)).toEqual(['gpt-5-5-high', 'devin/gpt-5-5'])
  })

  it('tries groups in key order (failover) or rotates them per request (mixed)', () => {
    const perGroup = new Map([['a', [{ kind: 'cpa', groupId: 'a' }]], ['b', [{ kind: 'cpa', groupId: 'b' }]]]) as never
    expect(sequenceAttempts({ groupIds: ['a', 'b'], strategy: 'failover', rotationKey: 'k', perGroup }).map(item => item.groupId)).toEqual(['a', 'b'])
    expect(sequenceAttempts({ groupIds: ['a', 'b'], strategy: 'failover', rotationKey: 'k', perGroup }).map(item => item.groupId)).toEqual(['a', 'b'])
    const first = orderGroups(['a', 'b', 'c'], 'mixed', 'rotation-test')
    const second = orderGroups(['a', 'b', 'c'], 'mixed', 'rotation-test')
    expect(first).toEqual(['a', 'b', 'c']); expect(second).toEqual(['b', 'c', 'a'])
  })

  it('tries a pool module in each of its groups, before that group\'s CPA sources', () => {
    const perGroup = new Map([['b', [{ kind: 'cpa', groupId: 'b' }]]]) as never
    const poolGroups = new Map([['logicc', new Map([['a', 'claude-x'], ['b', 'claude-x']])]]) as never
    const attempts = sequenceAttempts({ groupIds: ['a', 'b', 'c'], strategy: 'failover', rotationKey: 'k', perGroup, poolGroups })
    expect(attempts.map(item => `${item.kind}:${item.groupId}`)).toEqual(['pool:a', 'pool:b', 'cpa:b'])
    expect(attempts[0]).toMatchObject({ moduleId: 'logicc', nativeModel: 'claude-x' })
  })
})

describe('failover and stream outcome', () => {
  it('fails over on source problems but returns client errors', () => {
    for (const status of [401, 403, 404, 429, 500, 502, 503, 529]) expect(isFailoverResponse(status, '')).toBe(true)
    expect(isFailoverResponse(400, '{"error":{"message":"unknown provider for model x"}}')).toBe(true)
    expect(isFailoverResponse(400, '{"error":{"message":"messages: field required"}}')).toBe(false)
    expect(isFailoverResponse(422, '')).toBe(false)
    // A pool module that declines a kind of request hands it to the next source.
    expect(isFailoverResponse(422, '{"error":{"message":"Logicc 不支持 image_url","code":"nexus_source_unsupported"}}')).toBe(true)
    expect(errorMessageFrom('{"error":{"message":"permission_denied: an internal error occurred"}}')).toBe('permission_denied: an internal error occurred')
  })

  it('records in-stream errors and missing completion markers', () => {
    const encode = (text: string) => new TextEncoder().encode(text)
    const failed = new StreamOutcome(200, true)
    failed.push(encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\nevent: error\ndata: {"error":{"message":"upstream broke"}}\n\n')); failed.end()
    expect(failed.errorMessage).toBe('upstream broke'); expect(failed.logStatus(200)).toBe('error')
    const cut = new StreamOutcome(200, true)
    cut.push(encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); cut.end()
    expect(cut.logStatus(200)).toBe('incomplete')
    const done = new StreamOutcome(200, true)
    done.push(encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); done.end()
    expect(done.logStatus(200)).toBe('success')
    const json = new StreamOutcome(200, false)
    json.push(encode('{"id":"x","choices":[]}')); json.end()
    expect(json.logStatus(200)).toBe('success')
  })
})
