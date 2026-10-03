import { createError, defineEventHandler } from 'h3'
import { createRedisConnection } from '../lib/redis'
import { UPDATE_CHANNEL } from '../lib/events'
export default defineEventHandler(async event => {
  const response = event.node.res
  const subscriber = createRedisConnection()
  let closed = false
  let started = false
  let blocked = false
  let readyPending = true
  let pendingUpdate: string | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const cleanup = () => {
    if (closed) return
    closed = true
    pendingUpdate = undefined
    if (heartbeat) clearInterval(heartbeat)
    subscriber.off('message', onMessage)
    subscriber.disconnect()
    response.off('close', cleanup)
    response.off('finish', cleanup)
    response.off('drain', drained)
    response.off('error', failed)
    finish()
  }
  const failed = () => { cleanup(); response.destroy() }
  function write(name: string, data: string) {
    if (closed || response.destroyed || response.writableEnded) { cleanup(); return }
    const frame = 'event: ' + name + '\n' + data.split(/\r\n|\r|\n/).map(line => 'data: ' + line).join('\n') + '\n\n'
    try { blocked = !response.write(frame) }
    catch { failed() }
  }
  function flush() {
    if (closed || !started || blocked || response.writableNeedDrain) return
    if (readyPending) { readyPending = false; write('ready', '{}') }
    if (!closed && !blocked && pendingUpdate !== undefined) {
      const data = pendingUpdate
      pendingUpdate = undefined
      write('update', data)
    }
  }
  function drained() { blocked = false; flush() }
  function onMessage(_channel: string, message: string) {
    if (closed) return
    // Updates invalidate page data; only the latest notification is needed while
    // a browser is slow. Never queue unbounded writes behind socket backpressure.
    pendingUpdate = message
    flush()
  }
  response.once('close', cleanup)
  response.once('finish', cleanup)
  response.once('error', failed)
  response.on('drain', drained)
  subscriber.on('message', onMessage)
  if (response.destroyed) { cleanup(); return }
  try {
    await subscriber.subscribe(UPDATE_CHANNEL)
  } catch (error) {
    cleanup()
    if (response.destroyed) return
    throw createError({ statusCode: 503, statusMessage: '实时更新连接暂不可用', cause: error })
  }
  if (closed) return
  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('cache-control', 'no-cache')
  response.setHeader('connection', 'keep-alive')
  response.setHeader('x-accel-buffering', 'no')
  response.flushHeaders()
  started = true
  flush()
  if (closed) return
  heartbeat = setInterval(() => {
    if (!blocked && !response.writableNeedDrain) write('ping', '{}')
  }, 20000)
  return finished
})
