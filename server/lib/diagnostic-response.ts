import { createHash } from 'node:crypto'
import { isModelErrorPayload, redactDiagnosticFields, redactLogValue, redactSensitiveText } from '../../shared/log-privacy'

const encoder = new TextEncoder()

function logFileReference(name: string) { return 'request-log-' + createHash('sha256').update(name).digest('hex') + '.log' }
function logIndexPath(path: string) { return /^(?:observability\/logs\/errors|request-error-logs)$/.test(path.replace(/^v[08]\/management\//, '')) }
function logFiles(value: unknown): Array<Record<string, unknown>> {
  const files = value && typeof value === 'object' ? (value as { files?: unknown }).files : undefined
  return Array.isArray(files) ? files.filter(file => file && typeof file === 'object' && typeof file.name === 'string') : []
}

/** Historical filenames may include model/provider paths. An opaque stable
 * reference keeps downloads usable without exposing the original filename. */
export async function resolveDiagnosticDownloadPath(path: string, read: (path: string) => Promise<{ status: number; body: Uint8Array }>): Promise<string> {
  const slash = path.lastIndexOf('/')
  const index = path.slice(0, slash), reference = path.slice(slash + 1)
  if (!logIndexPath(index) || !/^request-log-[a-f0-9]{64}\.log$/.test(reference)) return path
  const response = await read(index)
  if (response.status >= 200 && response.status < 300) {
    let value: unknown
    try { value = JSON.parse(new TextDecoder().decode(response.body)) } catch { /* Report an opaque lookup failure below. */ }
    const match = logFiles(value).find(file => logFileReference(String(file.name)) === reference)
    if (match) return index + '/' + match.name
  }
  throw Object.assign(new Error('请求日志不存在或已清理，请重新读取日志列表'), { statusCode: 404 })
}

/** Preserve successful JSON byte-for-byte; only error documents are rewritten. */
export function redactModelResponseBody(body: Uint8Array, status: number): Uint8Array {
  const raw = new TextDecoder().decode(body)
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { return status >= 400 ? encoder.encode(redactSensitiveText(raw)) : body }
  if (status < 400 && !isModelErrorPayload(value)) return body
  const safe = redactLogValue(value)
  return JSON.stringify(safe) === JSON.stringify(value) ? body : encoder.encode(JSON.stringify(safe))
}

function redactSseFrame(frame: string, errorResponse: boolean): string {
  const lines = frame.split(/\r?\n/)
  const data = lines.filter(line => /^data:/.test(line)).map(line => line.slice(5).trimStart()).join('\n')
  const event = lines.find(line => /^event:/.test(line))?.slice(6).trim() || ''
  if (!data || data === '[DONE]') return errorResponse ? redactSensitiveText(frame) : frame
  let value: unknown
  try { value = JSON.parse(data) }
  catch { return errorResponse || /^(?:error|response\.failed|.*[._-]error)$/i.test(event) ? redactSensitiveText(frame) : frame }
  if (!errorResponse && !isModelErrorPayload(value) && !/^(?:error|response\.failed|.*[._-]error)$/i.test(event)) return frame
  const safe = redactLogValue(value)
  if (JSON.stringify(safe) === JSON.stringify(value) && redactSensitiveText(frame) === frame) return frame
  let inserted = false
  return lines.flatMap(line => {
    if (!line.startsWith('data:')) return [redactSensitiveText(line)]
    if (inserted) return []
    inserted = true
    return ['data: ' + JSON.stringify(safe)]
  }).join(frame.includes('\r\n') ? '\r\n' : '\n')
}

/** Buffer one SSE event across network/UTF-8 boundaries, then keep normal events
 * exactly as received. JSON errors must be inspected before any bytes are sent. */
export class DiagnosticResponseFilter {
  private readonly streaming: boolean
  private readonly buffered: boolean
  private readonly decoder = new TextDecoder()
  private frame = ''
  private parts: Uint8Array[] = []
  constructor(private readonly status: number, contentType: string, inspectJson = true) {
    this.streaming = /(?:^|;)\s*text\/event-stream(?:;|$)/i.test(contentType)
    this.buffered = !this.streaming && (status >= 400 || inspectJson && /(?:application\/(?:[\w.+-]*\+)?json)(?:;|$)/i.test(contentType))
  }
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.buffered) { this.parts.push(chunk); return [] }
    if (!this.streaming) return [chunk]
    this.frame += this.decoder.decode(chunk, { stream: true })
    const output: Uint8Array[] = []
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(this.frame))) {
      output.push(encoder.encode(redactSseFrame(this.frame.slice(0, boundary.index), this.status >= 400) + boundary[0]))
      this.frame = this.frame.slice(boundary.index + boundary[0].length)
    }
    return output
  }
  end(): Uint8Array[] {
    if (this.buffered) {
      const body = Buffer.concat(this.parts)
      this.parts = []
      return [redactModelResponseBody(body, this.status)]
    }
    if (!this.streaming) return []
    this.frame += this.decoder.decode()
    const tail = this.frame
    this.frame = ''
    return tail ? [encoder.encode(redactSseFrame(tail, this.status >= 400))] : []
  }
}

/** Includes original-console aliases and plugin management log endpoints. */
export function isDiagnosticLogPath(path: string): boolean {
  const relative = path.replace(/^v[08]\/management\//, '')
  return /^(?:observability\/logs(?:\/|$)|logs(?:\/|$)|request-error-logs(?:\/|$)|request-log(?:\/|$)|observability\/usage\/queue$)/.test(relative)
}

export function redactManagementResponse(path: string, response: { status: number; body: Uint8Array; headers: Headers }) {
  const raw = new TextDecoder().decode(response.body)
  let value: unknown
  try { value = JSON.parse(raw) } catch { /* Downloaded request/error logs are text. */ }
  if (logIndexPath(path) && value && typeof value === 'object') {
    const listing = value as Record<string, unknown>
    value = { ...listing, files: logFiles(value).map(file => ({ ...file, name: logFileReference(String(file.name)) })) }
  }
  let next: Uint8Array
  if (isDiagnosticLogPath(path) || response.status >= 400) {
    next = value === undefined ? encoder.encode(redactSensitiveText(raw)) : encoder.encode(JSON.stringify(redactLogValue(value)))
  } else if (value && typeof value === 'object') {
    const probe = value as Record<string, unknown>
    const apiProbe = path.replace(/^v[08]\/management\//, '') === 'requests/api-call'
    const failedProbe = apiProbe && Number(probe.status_code ?? probe.statusCode) >= 400
    let safe = failedProbe || isModelErrorPayload(value) ? redactLogValue(value) : redactDiagnosticFields(value)
    if (apiProbe && !failedProbe && typeof probe.body === 'string') {
      const safeBody = decodeProbeErrorBody(probe.body)
      if (safeBody !== probe.body) safe = { ...(safe as Record<string, unknown>), body: safeBody }
    }
    next = safe === value ? response.body : encoder.encode(JSON.stringify(safe))
  } else next = response.body
  if (next !== response.body) {
    response.body = next
    for (const header of ['content-length', 'content-encoding', 'etag', 'last-modified', 'content-md5', 'digest']) response.headers.delete(header)
  }
  if (isDiagnosticLogPath(path) || response.status >= 400) {
    const filename = response.headers.get('content-disposition')
    if (filename) response.headers.set('content-disposition', redactSensitiveText(filename))
  }
}

function decodeProbeErrorBody(body: string): string {
  const safe = redactModelResponseBody(encoder.encode(body), 200)
  return new TextDecoder().decode(safe)
}
