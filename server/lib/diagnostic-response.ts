import { createHash } from 'node:crypto'
import { isModelErrorPayload, redactDiagnosticFields, redactLogValue, redactSensitiveText } from '../../shared/log-privacy'
import { publicErrorBody, publicErrorMessage, publicErrorPayload } from './public-errors'

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

const ERROR_EVENT = /^(?:error|response\.failed|.*[._-]error)$/i

/** A redacted error SSE frame, further cleaned for model API callers. */
function publicSseFrame(frame: string, status: number, errorResponse: boolean): string {
  const lines = frame.split(/\r?\n/)
  const data = lines.filter(line => /^data:/.test(line)).map(line => line.slice(5).trimStart()).join('\n')
  const event = lines.find(line => /^event:/.test(line))?.slice(6).trim() || ''
  if (!data || data === '[DONE]') return frame
  const errorStatus = status >= 400 ? status : 502
  let value: unknown
  try { value = JSON.parse(data) } catch {
    if (!errorResponse && !ERROR_EVENT.test(event)) return frame
    return lines.map(line => line.startsWith('data:') ? 'data: ' + publicErrorMessage(line.slice(5).trimStart(), errorStatus) : line).join(frame.includes('\r\n') ? '\r\n' : '\n')
  }
  if (!errorResponse && !isModelErrorPayload(value) && !ERROR_EVENT.test(event)) return frame
  const safe = JSON.stringify(publicErrorPayload(value, errorStatus))
  if (safe === JSON.stringify(value)) return frame
  let inserted = false
  return lines.flatMap(line => {
    if (!line.startsWith('data:')) return [line]
    if (inserted) return []
    inserted = true
    return ['data: ' + safe]
  }).join(frame.includes('\r\n') ? '\r\n' : '\n')
}

export interface ResponseFilterOptions {
  /** The response goes to a model API caller: errors are cleaned with public-errors. */
  publicErrors?: boolean
  /** Exact strings replaced everywhere in the body, e.g. a bridge alias with the model name the caller knows. */
  rewrite?: [from: string, to: string][]
}

/** Buffer one SSE event across network/UTF-8 boundaries, then keep normal events
 * exactly as received. JSON errors must be inspected before any bytes are sent. */
export class DiagnosticResponseFilter {
  private readonly streaming: boolean
  private readonly buffered: boolean
  private readonly decoder = new TextDecoder()
  private frame = ''
  private parts: Uint8Array[] = []
  private readonly rewrite: [string, string][]
  constructor(private readonly status: number, contentType: string, inspectJson = true, private readonly options: ResponseFilterOptions = {}) {
    this.streaming = /(?:^|;)\s*text\/event-stream(?:;|$)/i.test(contentType)
    this.buffered = !this.streaming && (status >= 400 || inspectJson && /(?:application\/(?:[\w.+-]*\+)?json)(?:;|$)/i.test(contentType))
    this.rewrite = (options.rewrite ?? []).filter(([from, to]) => from && from !== to)
  }
  private replace(text: string): string {
    for (const [from, to] of this.rewrite) text = text.split(from).join(to)
    return text
  }
  private safeFrame(frame: string): string {
    const errorResponse = this.status >= 400
    const redacted = redactSseFrame(this.replace(frame), errorResponse)
    return this.options.publicErrors ? publicSseFrame(redacted, this.status, errorResponse) : redacted
  }
  private safeBody(body: Uint8Array): Uint8Array {
    const source = this.rewrite.length ? encoder.encode(this.replace(new TextDecoder().decode(body))) : body
    const redacted = redactModelResponseBody(source, this.status)
    if (!this.options.publicErrors) return redacted
    const text = new TextDecoder().decode(redacted)
    let error = this.status >= 400
    if (!error) { try { error = isModelErrorPayload(JSON.parse(text)) } catch { /* Not JSON: a success body. */ } }
    return error ? encoder.encode(publicErrorBody(text, this.status >= 400 ? this.status : 502)) : redacted
  }
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.buffered) { this.parts.push(chunk); return [] }
    if (!this.streaming) return [chunk]
    this.frame += this.decoder.decode(chunk, { stream: true })
    const output: Uint8Array[] = []
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(this.frame))) {
      output.push(encoder.encode(this.safeFrame(this.frame.slice(0, boundary.index)) + boundary[0]))
      this.frame = this.frame.slice(boundary.index + boundary[0].length)
    }
    return output
  }
  end(): Uint8Array[] {
    if (this.buffered) {
      const body = Buffer.concat(this.parts)
      this.parts = []
      return [this.safeBody(body)]
    }
    if (!this.streaming) return []
    this.frame += this.decoder.decode()
    const tail = this.frame
    this.frame = ''
    return tail ? [encoder.encode(this.safeFrame(tail))] : []
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
