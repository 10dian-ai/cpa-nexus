import { getRequestURL, type H3Event } from 'h3'
import { requireModule } from '../modules'
import { insertRequestLog } from '../logs'
import { forwardDevin2Api } from './forward'
import { listDevin2ApiGroupModels, resolveDevin2ApiModel, type Devin2ApiSelection } from './routing'
import { resolveKeyPresetStack } from '../presets'
import { applyPresetStack, resolvePresetGenerationType } from '../presets/engine'
import { BILLING_USAGE_POLICY, BILLING_USAGE_POLICY_HEADER, BillingUsageObserver, normalizeBillingRequest } from '../billing'

type Protocol = 'chat/completions' | 'messages' | 'responses'
type JsonObject = Record<string, unknown>
const PROTOCOLS = new Set<Protocol>(['chat/completions', 'messages', 'responses'])

function fail(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }) }

function pathFor(event: H3Event, explicit?: string) {
  const path = explicit || getRequestURL(event).pathname.replace(/^\/v1\//, '').replace(/^\/nexus\/cpa\/v1\//, '').replace(/\/$/, '')
  if (path !== 'models' && !PROTOCOLS.has(path as Protocol)) throw fail(404, 'Unsupported Devin model endpoint')
  return path
}

/**
 * `selection` is the account the platform router already resolved for this
 * exact model and key; passing it avoids a second catalog lookup that could
 * pick a different account (or fail) between routing and forwarding.
 */
export async function handleDevin2ApiInference(event: H3Event, input: { keyId: string; groupIds: string[]; protocolPath?: string; body?: JsonObject; selection?: Devin2ApiSelection }) {
  await requireModule('devin2api')
  const path = pathFor(event, input.protocolPath)
  if (path === 'models') {
    const models = await listDevin2ApiGroupModels(input.groupIds)
    event.node.res.statusCode = 200
    event.node.res.setHeader('content-type', 'application/json; charset=utf-8')
    event.node.res.end(JSON.stringify({ object: 'list', data: models }))
    return
  }
  let body: JsonObject = { ...(input.body || {}) }
  if (typeof body.model !== 'string' || !body.model.trim()) throw fail(400, 'model must be a non-empty string')
  const selected = input.selection || await resolveDevin2ApiModel(body.model, input.groupIds)
  if (!selected) throw fail(404, '当前 Key 的分组中没有可调用的这个 Devin 模型')
  event.node.res.setHeader('x-nexus-module', 'devin2api')
  event.node.res.setHeader('x-nexus-source-id', selected.account.id)
  // The selected source may overlap several key groups. Apply only the
  // preset stack for the group that actually authorized this account, rather
  // than merging unrelated group overrides into the same request.
  const presets = await resolveKeyPresetStack(input.keyId, [selected.matchedGroupId])
  // Keep the module usable with older preset engine extensions while the
  // generation type helper is rolled out; undefined means the default stack.
  const generationType = typeof resolvePresetGenerationType === 'function'
    ? resolvePresetGenerationType(body, event.node.req?.headers || {})
    : undefined
  if (presets.length) {
    body = applyPresetStack(presets, body, { protocol: path === 'chat/completions' ? 'chat' : path as 'messages' | 'responses', generationType }) as JsonObject
    event.node.res.setHeader('x-nexus-preset-id', presets.map(preset => preset.id).join(','))
  }
  if (Object.hasOwn(body, 'generation_type')) { body = { ...body }; delete body.generation_type }
  body = normalizeBillingRequest(body, path)
  event.node.res.setHeader(BILLING_USAGE_POLICY_HEADER, BILLING_USAGE_POLICY)
  const modelForLog = typeof body.model === 'string' ? body.model : String(body.model)
  const sessionForLog = typeof body.session_id === 'string' ? body.session_id : null
  const started = Date.now()
  const usageObserver = new BillingUsageObserver()
  const presetIds = presets.map(preset => preset.id)
  const usageWithMetadata = () => {
    const usage = usageObserver.value()
    return usage ? { ...usage, nexus: { moduleId: 'devin2api', groupIds: [...input.groupIds], presetIds } } : null
  }
  try {
    await forwardDevin2Api(event, `/v1/${path}`, { body, groupIds: [selected.matchedGroupId], selection: selected, usageObserver })
    await insertRequestLog({
      keyId: input.keyId, accountId: null, moduleId: 'devin2api', sourceId: selected.account.id,
      model: modelForLog, protocol: path as Protocol, sessionId: sessionForLog,
      status: (event.node.res.statusCode || 500) >= 400 ? 'error' : 'success', httpStatus: event.node.res.statusCode || null,
      durationMs: Date.now() - started, streaming: String(event.node.res.getHeader('content-type') || '').includes('text/event-stream'), usage: usageWithMetadata(),
      errorMessage: (event.node.res.statusCode || 500) >= 400 ? `Devin embedded runtime returned HTTP ${event.node.res.statusCode}` : null,
      requestBody: body, responseBody: null, responseTruncated: false,
    })
  } catch (error) {
    await insertRequestLog({
      keyId: input.keyId, accountId: null, moduleId: 'devin2api', sourceId: selected.account.id,
      model: modelForLog, protocol: path as Protocol, sessionId: sessionForLog,
      status: 'error', httpStatus: Number((error as { statusCode?: number }).statusCode) || null, durationMs: Date.now() - started,
      streaming: false, usage: usageWithMetadata(), errorMessage: error instanceof Error ? error.message : 'Devin request failed', requestBody: body, responseBody: null, responseTruncated: false,
    }).catch(() => undefined)
    throw error
  }
}

export function isDevin2ApiPath(path: string) { return path === 'models' || PROTOCOLS.has(path as Protocol) }
