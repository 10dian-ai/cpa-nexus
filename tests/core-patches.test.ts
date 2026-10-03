import { ResponseInspection } from '../server/lib/gateway/response'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
// The build script is intentionally plain ESM and runs no server when imported.
// @ts-ignore The build utility is plain JavaScript; its behavior is covered here.
import { applyCorePatches, CORE_CLI_VERSION, CORE_SOURCE_SHA256 } from '../scripts/build-core.mjs'

const original = readFileSync(resolve('reference/commandcode-proxy-6217305/proxy.mjs'))
const patched: string = applyCorePatches(original)
const usageHelpers = patched.slice(patched.indexOf('function managerToken('), patched.indexOf('function anthropicInputTokens('))
type TestExports = {
  convertResponsesToChat: (request: Record<string, unknown>) => Record<string, unknown>
  createResponsesSseTranslator: (model: string, id: string, created: number) => {
    parseLine: (line: string) => string[] | null
    finish: () => string[]
  }
  handleResponses: (req: object, res: object) => Promise<void>
}
function harness(body: Record<string, unknown> = {}, upstreamText = '') {
  const responsesOnly = patched.slice(patched.indexOf('function responsesTextOf('), patched.indexOf('async function handleModels('))
  const sent: { status: number; body: unknown }[] = []
  let upstreamCalls = 0
  const context = vm.createContext({
    randomUUID, nowUnix: () => 1_790_000_000,
    normalizeUsage: () => {},
    mapFinishReason: (reason: string) => reason,
    mapCcEventError: (event: { message?: string }) => ({ status: 502, body: { error: { type: 'upstream_error', message: event.message } } }),
    sendJSON: (_res: object, status: number, value: unknown) => { sent.push({ status, body: value }) },
    readBody: async () => body,
    getApiKey: () => 'fixture-key-no-network',
    buildCcRequest: (value: unknown) => value,
    ensureInitialized: async () => {},
    forwardToCC: async () => {
      upstreamCalls++
      return new Response(upstreamText, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    },
    AbortController, TextDecoder, Date,
    createIdleWatchdog: () => ({ arm: () => new Promise(() => {}), dispose: () => {} }),
    NONSTREAM_IDLE_TIMEOUT_MS: 1000,
    log: () => {},
    consecutiveTimeouts: 0,
  })
  vm.runInContext(usageHelpers + responsesOnly + '\nglobalThis.testExports = { convertResponsesToChat, createResponsesSseTranslator, handleResponses };', context)
  const exports = context.testExports as TestExports
  const request = { headers: {} }
  const response = { writableEnded: false, headersSent: false, destroyed: false, on: () => {} }
  return { ...exports, sent, request, response, upstreamCalls: () => upstreamCalls }
}

describe('reviewed fixed-core build', () => {
  it('refuses a changed upstream source instead of silently applying uncertain patches', () => {
    expect(CORE_SOURCE_SHA256).toHaveLength(64)
    expect(() => applyCorePatches(Buffer.concat([original, Buffer.from('\n')]))).toThrow('checksum mismatch')
  })
  it('pins the reviewed CLI version and removes the registry refresher', () => {
    expect(patched).toContain("const CC_VERSION = '" + CORE_CLI_VERSION + "';")
    expect(patched).not.toContain('refreshCCVersion()')
    expect(patched).not.toContain('setInterval(refreshCCVersion')
    expect(patched).not.toContain('https://registry.npmjs.org/command-code/latest')
  })
})

describe('Responses compatibility patches execute the patched source in isolation', () => {
  it('preserves prompt_cache_key and a valid message without explicit type', () => {
    const chat = harness().convertResponsesToChat({
      model: 'fixture/model', prompt_cache_key: 'conversation-cache',
      input: [{ role: 'developer', content: 'Instructions' }, { role: 'user', content: 'Hello' }],
    })
    expect(chat.prompt_cache_key).toBe('conversation-cache')
    expect(chat.messages).toEqual([{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Hello' }])
  })
  it('retains typed function call/output round trips', () => {
    const chat = harness().convertResponsesToChat({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
      ],
    })
    expect(chat.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
    ])
  })
  it('rejects store:true before any upstream request', async () => {
    const h = harness({ store: true, model: 'fixture/model', input: 'Hello' })
    await h.handleResponses(h.request, h.response)
    expect(h.sent[0]?.status).toBe(400)
    expect(JSON.stringify(h.sent[0]?.body)).toContain('store:true is not supported')
    expect(h.upstreamCalls()).toBe(0)
  })
  it('emits response.failed on stream EOF without an upstream finish', () => {
    const translator = harness().createResponsesSseTranslator('fixture/model', 'resp_test', 1)
    translator.parseLine(JSON.stringify({ type: 'text-delta', text: 'partial' }))
    const end = translator.finish().join('')
    expect(end).toContain('response.failed')
    expect(end).toContain('without finish event')
    expect(end).not.toContain('response.completed')
  })
  it('still emits completed or incomplete after a real finish event', () => {
    for (const reason of ['stop', 'length']) {
      const translator = harness().createResponsesSseTranslator('fixture/model', 'resp_test', 1)
      translator.parseLine(JSON.stringify({ type: 'text-delta', text: 'answer' }))
      translator.parseLine(JSON.stringify({ type: 'finish', finishReason: reason, usage: { inputTokens: 1, outputTokens: 1 } }))
      expect(translator.finish().join('')).toContain(reason === 'length' ? 'response.incomplete' : 'response.completed')
    }
  })
  it('returns an error on non-stream EOF without finish instead of a successful partial answer', async () => {
    const h = harness({ model: 'fixture/model', input: 'Hello' }, JSON.stringify({ type: 'text-delta', text: 'partial' }) + '\n')
    await h.handleResponses(h.request, h.response)
    expect(h.sent[0]?.status).toBe(502)
    expect(JSON.stringify(h.sent[0]?.body)).toContain('without finish event')
  })
  it('accepts a complete final NDJSON finish line without a trailing newline', async () => {
    const wire = JSON.stringify({ type: 'text-delta', text: 'answer' }) + '\n' +
      JSON.stringify({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } })
    const h = harness({ model: 'fixture/model', input: 'Hello', store: false }, wire)
    await h.handleResponses(h.request, h.response)
    expect(h.sent[0]?.status).toBe(200)
    expect(h.sent[0]?.body).toMatchObject({ status: 'completed', output_text: 'answer' })
  })
})

function legacyHarness(body: Record<string, unknown>, upstreamText = '', initializing = false, readError = false) {
  const sent: { status: number; body: unknown }[] = []
  const writes: string[] = []
  const watchdogs: { disposed: boolean }[] = []
  let requestSignal: AbortSignal | undefined
  let initializeSignal: AbortSignal | undefined
  let continueInitialization: (() => void) | undefined
  const initialization = new Promise<void>(resolve => { continueInitialization = resolve })
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false, headersSent: false, destroyed: false, writableNeedDrain: false,
    headers: {} as Record<string, string>,
    write(value: string) { this.headersSent = true; writes.push(value); return true },
    writeHead(_status: number, headers: Record<string, string>) { this.headersSent = true; this.headers = headers; return this },
    setHeader(name: string, value: string) { this.headers[name] = value },
    end(value?: string) { if (value) writes.push(value); this.writableEnded = true },
    destroy() { this.destroyed = true },
  })
  const context = vm.createContext({
    randomUUID, nowUnix: () => 1_790_000_000,
    normalizeUsage: () => {}, anthropicInputTokens: (usage: { inputTokens?: number } | null) => usage?.inputTokens ?? 0,
    mapFinishReason: (reason: string) => reason, tryParseJSON: JSON.parse,
    mapCcEventError: (event: { message?: string }) => ({ status: 502, body: { error: { type: 'upstream_error', message: event.message } } }),
    sendJSON: (_res: object, status: number, value: unknown) => { sent.push({ status, body: value }); response.end() },
    readBody: async () => body, getApiKey: () => 'fixture-key-no-network', buildCcRequest: (value: unknown) => value,
    ensureInitialized: async (_key: string, signal: AbortSignal) => {
      initializeSignal = signal
      if (initializing) await initialization
      signal.throwIfAborted()
    },
    forwardToCC: async (_body: unknown, _key: string, _headers: unknown, signal: AbortSignal) => {
      requestSignal = signal
      if (readError) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Fixture upstream read failure')) } }))
      return new Response(upstreamText, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    },
    AbortController, TextDecoder, Date, setInterval, clearInterval,
    createIdleWatchdog: () => {
      const watchdog = { disposed: false }
      watchdogs.push(watchdog)
      return { arm: () => new Promise(() => {}), dispose: () => { watchdog.disposed = true } }
    },
    waitDrain: async () => {}, STREAM_IDLE_TIMEOUT_MS: 1000, NONSTREAM_IDLE_TIMEOUT_MS: 1000,
    log: () => {}, consecutiveTimeouts: 0, TIMEOUT_REDUCE_CONTEXT_THRESHOLD: 3,
  })
  const translator = patched.slice(patched.indexOf('function createSseTranslator('), patched.indexOf('function normalizeUsage('))
  const handlers = patched.slice(patched.indexOf('async function handleChatCompletions('), patched.indexOf('async function fetchModels('))
  vm.runInContext(usageHelpers + translator + handlers + '\nglobalThis.handlers = { handleChatCompletions, handleMessages };', context)
  const handlersByProtocol = context.handlers as Record<string, (req: object, res: object) => Promise<void>>
  return {
    run: (protocol: string) => handlersByProtocol[protocol]!({ headers: {} }, response),
    response, writes, sent, watchdogs, continueInitialization: () => continueInitialization!(),
    requestSignal: () => requestSignal, initializeSignal: () => initializeSignal,
  }
}

describe('Chat and Messages adapters preserve completion and cancellation evidence', () => {
  for (const protocol of ['handleChatCompletions', 'handleMessages']) {
    for (const stream of [false, true]) {
      it(`${protocol} stream=${stream} rejects partial output without a finish event`, async () => {
        const wire = JSON.stringify({ type: 'text-delta', text: 'partial' }) + '\n' +
          JSON.stringify({ type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } }) + '\n'
        const h = legacyHarness({ model: 'fixture/model', stream, messages: [{ role: 'user', content: 'Hello' }] }, wire)
        await h.run(protocol)
        const result = JSON.stringify(h.sent) + h.writes.join('')
        expect(result).toContain('without finish event')
        expect(h.sent.some(value => value.status === 200)).toBe(false)
        expect(h.writes.join('')).not.toContain('data: [DONE]')
        expect(h.writes.join('')).not.toContain('event: message_stop')
      })
      it(`${protocol} stream=${stream} accepts a complete final finish line without newline`, async () => {
        const wire = JSON.stringify({ type: 'text-delta', text: 'answer' }) + '\n' +
          JSON.stringify({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } })
        const h = legacyHarness({ model: 'fixture/model', stream, messages: [{ role: 'user', content: 'Hello' }] }, wire)
        await h.run(protocol)
        if (stream) {
          expect(h.writes.join('')).toContain(protocol === 'handleMessages' ? 'event: message_stop' : 'data: [DONE]')
          expect(h.writes.join('')).not.toContain('event: error')
          expect(h.response.headers['Content-Type']).toBe('text/event-stream')
        } else {
          expect(h.sent[0]?.status).toBe(200)
          expect(JSON.stringify(h.sent[0]?.body)).toContain('answer')
        }
      })
    }
    it(`${protocol} cancels initialization when the client leaves before upstream headers`, async () => {
      const h = legacyHarness({ model: 'fixture/model', messages: [{ role: 'user', content: 'Hello' }] }, '', true)
      const pending = h.run(protocol)
      await vi.waitFor(() => expect(h.initializeSignal()).toBeDefined())
      h.response.destroyed = true
      h.response.emit('close')
      expect(h.initializeSignal()?.aborted).toBe(true)
      h.continueInitialization()
      await pending
      expect(h.requestSignal()).toBeUndefined()
    })
  }
  for (const stream of [false, true]) {
    it(`Chat stream=${stream} accepts real output when the upstream omits token usage`, async () => {
      const wire = JSON.stringify({ type: 'text-delta', text: 'answer' }) + '\n' +
        JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n'
      const h = legacyHarness({ model: 'fixture/model', stream, messages: [{ role: 'user', content: 'Hello' }] }, wire)
      await h.run('handleChatCompletions')
      if (stream) expect(h.writes.join('')).toContain('data: [DONE]')
      else expect(h.sent[0]?.status).toBe(200)
      expect(JSON.stringify(h.sent) + h.writes.join('')).not.toContain('Empty response')
    })
  }
})

describe('core usage stays faithful to upstream observations', () => {
  const usage = { inputTokens: 30, outputTokens: 0, cachedInputTokens: 10, inputTokenDetails: { noCacheTokens: 20, cacheWriteTokens: 0 } }
  for (const protocol of ['handleChatCompletions', 'handleMessages']) {
    for (const stream of [false, true]) {
      for (const observed of [usage, undefined]) {
        it(`${protocol} stream=${stream} preserves ${observed ? 'zero output and nonzero input' : 'missing usage'}`, async () => {
          const wire = JSON.stringify({ type: 'text-delta', text: 'answer' }) + '\n' +
            JSON.stringify({ type: 'finish', finishReason: 'stop', usage: observed }) + '\n'
          const h = legacyHarness({ model: 'fixture/model', stream, messages: [{ role: 'user', content: 'Hello' }] }, wire)
          await h.run(protocol)
          const inspection = new ResponseInspection()
          if (stream) { inspection.push(new TextEncoder().encode(h.writes.join(''))); inspection.end() }
          else inspection.observe(h.sent[0]?.body)
          expect(inspection.failure).toBeNull()
          expect(inspection.hasOutput).toBe(true)
          if (!observed) expect(inspection.usage).toBeNull()
          else expect(inspection.usage).toMatchObject(protocol === 'handleMessages'
            ? { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }
            : { prompt_tokens: 30, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 10 } })
          if (protocol === 'handleMessages' && stream) {
            const events = h.writes.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
            expect(events.find(event => event.type === 'message_start').message.usage).toEqual({})
            expect(events.find(event => event.type === 'message_delta').usage).toBeTypeOf('object')
          }
        })
      }
    }
  }
  for (const observed of [usage, undefined]) {
    it(`Responses preserves ${observed ? 'zero output and nonzero input' : 'missing usage'} in JSON and SSE`, async () => {
      const wire = JSON.stringify({ type: 'text-delta', text: 'answer' }) + '\n' +
        JSON.stringify({ type: 'finish', finishReason: 'stop', usage: observed }) + '\n'
      const h = harness({ model: 'fixture/model', input: 'Hello' }, wire)
      await h.handleResponses(h.request, h.response)
      const json = h.sent[0]?.body as { usage: unknown }
      const translator = harness().createResponsesSseTranslator('fixture/model', 'resp_usage', 1)
      translator.parseLine(JSON.stringify({ type: 'text-delta', text: 'answer' }))
      translator.parseLine(JSON.stringify({ type: 'finish', finishReason: 'stop', usage: observed }))
      const inspection = new ResponseInspection()
      inspection.push(new TextEncoder().encode(translator.finish().join('')))
      inspection.end()
      if (!observed) {
        expect(json.usage).toBeNull()
        expect(inspection.usage).toBeNull()
      } else {
        const expected = { input_tokens: 30, output_tokens: 0, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 } }
        expect(json.usage).toMatchObject(expected)
        expect(inspection.usage).toMatchObject(expected)
      }
    })
  }
})

describe('core terminal errors and timers', () => {
  it('does not emit a successful Chat completion after an upstream error', async () => {
    const wire = [
      { type: 'text-delta', text: 'partial' },
      { type: 'error', message: 'Fixture generation failed' },
      { type: 'finish', finishReason: 'stop', usage: { outputTokens: 1 } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n'
    const h = legacyHarness({ model: 'fixture/model', stream: true, messages: [] }, wire)
    await h.run('handleChatCompletions')
    expect(h.writes.join('')).toContain('Fixture generation failed')
    expect(h.writes.join('')).not.toContain('"finish_reason":"stop"')
    expect(h.writes.join('')).not.toContain('data: [DONE]')
  })
  it('uses the final Chat finish reason instead of a prior step reason', async () => {
    const wire = [
      { type: 'text-delta', text: 'partial' },
      { type: 'finish-step', finishReason: 'stop', usage: { outputTokens: 1 } },
      { type: 'finish', finishReason: 'length', usage: { outputTokens: 1 } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n'
    const h = legacyHarness({ model: 'fixture/model', stream: true, messages: [] }, wire)
    await h.run('handleChatCompletions')
    expect(h.writes.join('')).toContain('"finish_reason":"length"')
    expect(h.writes.join('')).not.toContain('"finish_reason":"stop"')
  })
  for (const protocol of ['handleChatCompletions', 'handleMessages']) {
    it(`${protocol} disposes the nonstream watchdog after a rejected read`, async () => {
      const h = legacyHarness({ model: 'fixture/model', messages: [] }, '', false, true)
      await h.run(protocol)
      expect(h.watchdogs).toHaveLength(1)
      expect(h.watchdogs[0]?.disposed).toBe(true)
      expect(JSON.stringify(h.sent) + h.writes.join('')).toContain('Fixture upstream read failure')
    })
  }
})
