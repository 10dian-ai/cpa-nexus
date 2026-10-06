import { getRequestURL, type H3Event } from 'h3'
import { requireModule } from '../modules'
import { insertRequestLog } from '../logs'
import { forwardDevin2Api } from './forward'
import { listDevin2ApiGroupModels, resolveDevin2ApiModel } from './routing'
import { resolveKeyPresetStack } from '../presets'
import { applyPresetStack } from '../presets/engine'

type Protocol = 'chat/completions' | 'messages' | 'responses'
type JsonObject = Record<string, unknown>
const PROTOCOLS = new Set<Protocol>(['chat/completions', 'messages', 'responses'])

function fail(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }) }

function pathFor(event: H3Event, explicit?: string) {
  const path = explicit || getRequestURL(event).pathname.replace(/^\/v1\//, '').replace(/^\/nexus\/cpa\/v1\//, '').replace(/\/$/, '')
  if (path !== 'models' && !PROTOCOLS.has(path as Protocol)) throw fail(404, 'Unsupported Devin model endpoint')
  return path
}

export async function handleDevin2ApiInference(event: H3Event, input: { keyId: string; groupIds: string[]; protocolPath?: string; body?: JsonObject }) {
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
  const selected = await resolveDevin2ApiModel(body.model, input.groupIds)
  if (!selected) throw fail(404, '当前 Key 的分组中没有可调用的这个 Devin 模型')
  event.node.res.setHeader('x-nexus-module', 'devin2api')
  event.node.res.setHeader('x-nexus-source-id', selected.account.id)
  const presets = await resolveKeyPresetStack(input.keyId, input.groupIds)
  if (presets.length) {
    body = applyPresetStack(presets, body, { protocol: path === 'chat/completions' ? 'chat' : path as 'messages' | 'responses' }) as JsonObject
    event.node.res.setHeader('x-nexus-preset-id', presets.map(preset => preset.id).join(','))
  }
  const modelForLog = typeof body.model === 'string' ? body.model : String(body.model)
  const sessionForLog = typeof body.session_id === 'string' ? body.session_id : null
  const started = Date.now()
  try {
    await forwardDevin2Api(event, `/v1/${path}`, { body, groupIds: input.groupIds })
    await insertRequestLog({
      keyId: input.keyId, accountId: null, moduleId: 'devin2api', sourceId: selected.account.id,
      model: modelForLog, protocol: path as Protocol, sessionId: sessionForLog,
      status: (event.node.res.statusCode || 500) >= 400 ? 'error' : 'success', httpStatus: event.node.res.statusCode || null,
      durationMs: Date.now() - started, streaming: String(event.node.res.getHeader('content-type') || '').includes('text/event-stream'), usage: null,
      errorMessage: (event.node.res.statusCode || 500) >= 400 ? `Devin sidecar returned HTTP ${event.node.res.statusCode}` : null,
      requestBody: body, responseBody: null, responseTruncated: false,
    })
  } catch (error) {
    await insertRequestLog({
      keyId: input.keyId, accountId: null, moduleId: 'devin2api', sourceId: selected.account.id,
      model: modelForLog, protocol: path as Protocol, sessionId: sessionForLog,
      status: 'error', httpStatus: Number((error as { statusCode?: number }).statusCode) || null, durationMs: Date.now() - started,
      streaming: false, usage: null, errorMessage: error instanceof Error ? error.message : 'Devin request failed', requestBody: body, responseBody: null, responseTruncated: false,
    }).catch(() => undefined)
    throw error
  }
}

export function isDevin2ApiPath(path: string) { return path === 'models' || PROTOCOLS.has(path as Protocol) }
