import type { H3Event } from 'h3'
import { getRedis } from '../../lib/redis'
import { getSettings } from '../../lib/settings'
import { upstreamIdleTimeoutMs } from '../../lib/timeouts'
import { acquireLease, cooldownAccount, releaseLease, startLeaseRenewal, type Lease } from '../../lib/pool/scheduler'
import { writeBridgeTrace, type BridgeTrace } from '../../lib/bridge/trace'
import { getDb } from '../../lib/db'
import { LOGICC_POOL_ID } from './config'
import { LogiccError, redactLogiccText } from './errors'
import { buildPrompt, normalizeChatRequest, parseToolOutput, type NormalizedChat } from './prompt'
import { createChat, generate, parseAiSdkStream, reportedUsage } from './client'
import { listCandidates, markAccountStatus, touchAccount } from './store'
import { getLogiccSettings } from './settings'
import { calibrateOutputSample, computeUsage, localTokens, officialCount, recordOfficialCount, tokenFamily } from './tokens'
import { ChatOutput, sendChatError } from './output'
import type { BridgeRequestContext } from '../contract'

/** Merged prompts above this size are refused; another source may accept the request. */
const MAX_PROMPT_BYTES = 4 * 1024 * 1024
/** Error code that tells the unified router another source may serve the request. */
export const SOURCE_UNSUPPORTED_CODE = 'nexus_source_unsupported'

const modelDeniedKey = (accountId: string, model: string) => `ccm:logicc:model-denied:${accountId}:${model}`

async function modelProvider(model: string): Promise<string> {
  const rows = await getDb()`SELECT m->>'provider' AS provider FROM logicc_accounts a CROSS JOIN LATERAL jsonb_array_elements(a.models) m
    WHERE m->>'id'=${model} LIMIT 1`
  return rows[0]?.provider ? String(rows[0].provider) : ''
}

function respondFailure(event: H3Event, error: LogiccError) {
  if (error.kind === 'unsupported') return sendChatError(event.node.res, 422, error.message, SOURCE_UNSUPPORTED_CODE)
  if (error.kind === 'client') return sendChatError(event.node.res, error.status >= 400 && error.status < 500 ? error.status : 400, error.message, 'invalid_request')
  if (error.kind === 'rate_limit') return sendChatError(event.node.res, 429, error.message, 'rate_limited', 30)
  if (error.kind === 'generation') return sendChatError(event.node.res, 502, error.message, 'generation_error')
  // Credentials, models and transient upstream failures: the router may try another group or source.
  return sendChatError(event.node.res, 503, error.message, 'logicc_unavailable', 10)
}

interface AttemptResult { output: string; toolResults: string[]; reasoning: string; finishReason: string; reported: { input: number; output: number } | null }

/**
 * Serve one Chat Completions request that CPA forwarded through the Logicc
 * bridge. Accounts come only from the call group the router signed for this
 * request; a failure before the first generated token moves to the next
 * account, a failure afterwards is reported in the response.
 */
export async function handleLogiccChat(event: H3Event, body: Record<string, unknown>, context: BridgeRequestContext): Promise<void> {
  const res = event.node.res
  const trace: BridgeTrace = { moduleId: 'logicc', accountId: null, attempts: [] }
  // The router reads this when it writes the request log, right after our last byte:
  // save it before finishing the response, never after.
  let traceSaved = false
  const saveTrace = async () => { traceSaved = true; await writeBridgeTrace(context.requestId, trace) }
  const settings = await getLogiccSettings()
  let request: NormalizedChat
  try {
    request = normalizeChatRequest(body)
    if (settings.toolPolicy === 'reject' && request.tools.length) throw new LogiccError('unsupported', 422, 'Logicc 模块设置为不处理工具调用请求，已交给其他来源')
  } catch (error) {
    const failure = error instanceof LogiccError ? error : new LogiccError('client', 400, '请求格式不正确')
    trace.attempts.push({ accountId: '', status: failure.status, error: failure.message })
    await saveTrace()
    return respondFailure(event, failure)
  }
  const prompt = buildPrompt(request)
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) { await saveTrace(); return respondFailure(event, new LogiccError('unsupported', 422, '合并后的上下文超过 Logicc 单次提示上限，已交给其他来源')) }

  const family = tokenFamily(request.model, await modelProvider(request.model).catch(() => ''))
  const usageKeyed = family === 'claude' || family === 'gemini'
  // Count the prompt officially while Logicc generates; it never delays the answer.
  const officialPrompt = usageKeyed ? officialCount(family, prompt, settings).catch(() => null) : Promise.resolve(null)

  const redis = getRedis()
  const controller = new AbortController()
  const onClose = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')) }
  res.once('close', onClose)
  const idleMs = upstreamIdleTimeoutMs(await getSettings())
  const tried = new Set<string>()
  const toolMode = request.activeTools.length > 0
  const output = new ChatOutput(res, request.model, request.stream)
  let lastError: LogiccError | null = null
  try {
    for (let attempt = 0; attempt < settings.maxAccountAttempts; attempt++) {
      const all = await listCandidates(context.groupId, request.model)
      const denied = all.length ? await redis.mget(...all.map(candidate => modelDeniedKey(candidate.id, request.model))) : []
      const candidates = all.filter((candidate, index) => !tried.has(candidate.id) && !denied[index])
      if (!candidates.length) {
        lastError ??= new LogiccError('upstream', 503, all.length ? '这个分组的 Logicc 账号暂时都不可用' : '这个分组没有能调用该模型的 Logicc 账号')
        break
      }
      const acquired = await acquireLease(redis, LOGICC_POOL_ID, { candidates })
      if (!acquired.ok) {
        lastError = acquired.reason === 'busy'
          ? new LogiccError('rate_limit', 429, 'Logicc 账号并发已满，请稍后重试')
          : new LogiccError('upstream', 503, '这个分组的 Logicc 账号正在冷却，请稍后重试')
        break
      }
      const lease: Lease = acquired.lease
      tried.add(lease.accountId)
      const stopRenewal = startLeaseRenewal(redis, lease, () => { /* The lease is advisory; the request finishes. */ })
      try {
        const result = await runAttempt(lease.accountId, request, prompt, output, toolMode, controller.signal, idleMs)
        trace.accountId = lease.accountId
        const official = await officialPrompt
        if (official && settings.usage.autoCalibrate) void recordOfficialCount(family, 'input', localTokens(prompt), official).catch(() => {})
        const usage = await computeUsage({ family, prompt, toolResults: result.toolResults, output: result.output + result.reasoning, officialPrompt: official, reported: result.reported }, settings)
        trace.usageSource = usage.source
        trace.usageDetail = usage.detail
        const parsed = toolMode ? parseToolOutput(result.output, request) : { text: result.output, calls: [] }
        output.commit()
        await saveTrace()
        output.finish({ text: parsed.text, reasoning: result.reasoning, calls: parsed.calls, finishReason: result.finishReason, usage: usage.usage }, toolMode)
        void touchAccount(lease.accountId).catch(() => {})
        void calibrateOutputSample(family, result.output + result.reasoning, settings).catch(() => {})
        return
      } catch (error) {
        const failure = error instanceof LogiccError ? error
          : controller.signal.aborted ? new LogiccError('client', 499, '客户端已取消请求')
          : new LogiccError('upstream', 502, redactLogiccText(error instanceof Error ? error.message : 'Logicc 请求失败'))
        trace.attempts.push({ accountId: lease.accountId, status: failure.status, error: failure.message })
        if (failure.accountSpecific) {
          if (failure.cooldownSeconds) await cooldownAccount(redis, LOGICC_POOL_ID, lease.accountId, failure.cooldownSeconds).catch(() => {})
          if (failure.kind === 'model') await redis.set(modelDeniedKey(lease.accountId, request.model), '1', 'EX', 600).catch(() => {})
          if (failure.kind === 'credential') await markAccountStatus(lease.accountId, 'credential_expired', failure.message).catch(() => {})
        }
        lastError = failure
        if (output.committed || controller.signal.aborted || !failure.accountSpecific) break
      } finally {
        stopRenewal()
        await releaseLease(redis, lease).catch(() => {})
      }
    }
    if (controller.signal.aborted) return
    const failure = lastError ?? new LogiccError('upstream', 503, 'Logicc 请求失败')
    await saveTrace()
    if (output.committed) output.fail(failure.message, failure.kind)
    else respondFailure(event, failure)
  } finally {
    output.dispose()
    res.off('close', onClose)
    if (!traceSaved) await writeBridgeTrace(context.requestId, trace)
  }
}

async function runAttempt(accountId: string, request: NormalizedChat, prompt: string, output: ChatOutput, toolMode: boolean, clientSignal: AbortSignal, idleMs: number): Promise<AttemptResult> {
  const idle = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const reset = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => idle.abort(new LogiccError('network', 504, 'Logicc 长时间没有返回数据')), idleMs); timer.unref() }
  const signal = AbortSignal.any([clientSignal, idle.signal])
  reset()
  try {
    const chatId = await createChat(accountId, signal)
    reset()
    const stream = await generate(accountId, chatId, { modelId: request.model, prompt, reasoningEffort: request.reasoning, forcedTool: request.forcedTool }, signal)
    let text = '', reasoning = '', finishReason = 'stop', finished = false
    let reported: AttemptResult['reported'] = null
    const toolResults: string[] = []
    for await (const event of parseAiSdkStream(stream)) {
      reset()
      switch (event.type) {
        case 'text-delta':
          if (typeof event.delta === 'string' && event.delta) {
            text += event.delta
            if (!toolMode) { output.commit(); output.content(event.delta) }
          }
          break
        case 'reasoning-delta':
          if (typeof event.delta === 'string' && event.delta) { reasoning += event.delta; if (!toolMode) { output.commit(); output.reasoningDelta(event.delta) } }
          break
        case 'tool-input-start':
          if (request.forcedTool && !toolMode) { output.commit(); const marker = `\n[tool:${event.toolName || request.forcedTool}] `; text += marker; output.content(marker) }
          break
        case 'tool-output-available':
          // Built-in Logicc tools (web search…) feed their results back into the model: billed as input.
          if (event.output !== undefined) toolResults.push(typeof event.output === 'string' ? event.output : JSON.stringify(event.output))
          break
        case 'error':
          throw new LogiccError('upstream', 502, `Logicc 生成失败：${redactLogiccText(event.errorText || '未知错误')}`)
        case 'finish':
          finished = true
          finishReason = event.finishReason === 'length' ? 'length' : event.finishReason === 'content-filter' || event.finishReason === 'content_filter' ? 'content_filter' : 'stop'
          break
        default:
          break
      }
      reported = reportedUsage(event) ?? reported
    }
    if (!finished) throw new LogiccError('upstream', 502, 'Logicc 数据流提前结束，没有收到完成事件')
    return { output: text, toolResults, reasoning, finishReason, reported }
  } catch (error) {
    if (idle.signal.aborted && idle.signal.reason instanceof LogiccError) throw idle.signal.reason
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
