import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const fixture = vi.hoisted(() => ({ subscribers: [] as any[], subscribe: vi.fn(async () => 1) }))
vi.mock('../server/lib/redis', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    createRedisConnection: () => {
      const subscriber = new EventEmitter() as any
      subscriber.subscribe = fixture.subscribe
      subscriber.disconnect = vi.fn()
      fixture.subscribers.push(subscriber)
      return subscriber
    },
  }
})
import eventsHandler from '../server/api/events.get'

describe('SSE over a real H3 HTTP connection', () => {
  let server: Server | undefined
  let controller: AbortController
  let intervalSpy: MockInstance<typeof globalThis.setInterval>
  beforeEach(() => {
    fixture.subscribers.length = 0
    fixture.subscribe.mockReset().mockResolvedValue(1)
    controller = new AbortController()
    intervalSpy = vi.spyOn(globalThis, 'setInterval')
  })
  afterEach(async () => {
    controller.abort()
    // Ensure a regression cannot leave the handler's heartbeat timer keeping the test process alive.
    for (const result of intervalSpy.mock.results) if (result.type === 'return') clearInterval(result.value)
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    vi.restoreAllMocks()
  })
  it('sends response headers and ready immediately, forwards updates, then releases Redis and the heartbeat on disconnect', async () => {
    const app = createApp()
    app.use('/api/events', eventsHandler)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    const readEvent = async () => {
      let text = ''
      while (!text.includes('\n\n')) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('SSE closed before delivering an event')
        text += decoder.decode(chunk.value, { stream: true })
      }
      return text
    }
    expect(await readEvent()).toContain('event: ready\ndata: {}\n\n')
    const subscriber = fixture.subscribers[0]
    expect(subscriber.subscribe).toHaveBeenCalledExactlyOnceWith('ccm:events')
    subscriber.emit('message', 'ccm:events', JSON.stringify({ type: 'keys' }))
    expect(await readEvent()).toContain('event: update\ndata: {"type":"keys"}\n\n')
    const heartbeat = intervalSpy.mock.results[intervalSpy.mock.calls.findIndex(call => call[1] === 20000)]?.value
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    controller.abort()
    await vi.waitFor(() => {
      expect(subscriber.disconnect).toHaveBeenCalledTimes(1)
      expect(clearSpy).toHaveBeenCalledWith(heartbeat)
    }, { timeout: 1500 })
  })
  it('releases its Redis connection when subscription fails before any headers are sent', async () => {
    fixture.subscribe.mockRejectedValueOnce(new Error('Redis is unavailable'))
    const app = createApp()
    app.use('/api/events', eventsHandler)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const response = await fetch('http://127.0.0.1:' + port + '/api/events', {
      signal: AbortSignal.timeout(1500),
    })
    expect(response.status).toBe(503)
    await response.arrayBuffer()
    expect(fixture.subscribers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(intervalSpy.mock.calls.some(call => call[1] === 20000)).toBe(false)
  })
  it('releases Redis if the browser disconnects while subscription is pending', async () => {
    let finishSubscribe!: (value: number) => void
    fixture.subscribe.mockImplementationOnce(() => new Promise(resolve => { finishSubscribe = resolve }))
    const app = createApp()
    app.use('/api/events', eventsHandler)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const response = fetch('http://127.0.0.1:' + port + '/api/events', {
      signal: controller.signal,
    }).catch(() => undefined)
    await vi.waitFor(() => expect(fixture.subscribe).toHaveBeenCalledTimes(1))
    controller.abort()
    await response
    try {
      await vi.waitFor(() => expect(fixture.subscribers[0].disconnect).toHaveBeenCalledTimes(1))
    } finally {
      finishSubscribe(1)
    }
    await new Promise(resolve => setImmediate(resolve))
    expect(intervalSpy.mock.calls.some(call => call[1] === 20000)).toBe(false)
    expect(fixture.subscribers[0].disconnect).toHaveBeenCalledTimes(1)
  })

  it('keeps only the latest update while a client is blocked, then resumes on drain', async () => {
    const app = createApp()
    app.use('/api/events', eventsHandler)
    server = createServer(toNodeListener(app))
    let socketResponse: import('node:http').ServerResponse | undefined
    const writes: string[] = []
    server.prependOnceListener('request', (_request, response) => {
      socketResponse = response
      const original = response.write.bind(response)
      let firstUpdate = true
      response.write = ((chunk: string) => {
        writes.push(chunk)
        const result = original(chunk)
        if (firstUpdate && chunk.startsWith('event: update')) { firstUpdate = false; return false }
        return result
      }) as typeof response.write
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const response = await fetch('http://127.0.0.1:' + port + '/api/events', { signal: controller.signal })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready')
    const subscriber = fixture.subscribers[0]
    for (let sequence = 0; sequence < 100; sequence++) {
      subscriber.emit('message', 'ccm:events', JSON.stringify({ type: 'account', sequence }))
    }
    expect(writes).toHaveLength(2)
    expect(writes[1]).toContain('"sequence":0')
    // A heartbeat also must not add writes while the downstream is stalled.
    const heartbeat = intervalSpy.mock.calls.find(call => call[1] === 20000)![0] as () => void
    heartbeat()
    expect(writes).toHaveLength(2)
    socketResponse!.emit('drain')
    expect(writes).toHaveLength(3)
    expect(writes[2]).toContain('"sequence":99')
    socketResponse!.emit('drain')
    expect(writes).toHaveLength(3)
    controller.abort()
    await vi.waitFor(() => expect(subscriber.disconnect).toHaveBeenCalledTimes(1))
    expect(subscriber.listenerCount('message')).toBe(0)
    expect(socketResponse!.listenerCount('drain')).toBe(0)
  })
})