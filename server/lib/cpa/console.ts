import { createError, getHeader, readRawBody, send, setHeader, setResponseStatus, type H3Event } from 'h3'
import { CpaClientError, cpaPathSegments, createCpaClient } from './client'
import { cpaDownstreamAbort } from './http'
import { requireAdmin } from '../auth'

const PREFIX = '/api/cpa/console/'
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** The official UI keeps its own preferences and never receives the actual management key. */
export const CONSOLE_BOOTSTRAP = `<script id="nexus-cpa-console-bootstrap">(()=>{
 const prefix='nexus:cpa-console:';
 const scoped=new Set(['cli-proxy-auth','isLoggedIn','cli-proxy-theme','cli-proxy-language','apiBase','apiUrl','managementKey']);
 const originalGet=Storage.prototype.getItem,originalSet=Storage.prototype.setItem,originalRemove=Storage.prototype.removeItem;
 Storage.prototype.getItem=function(name){return originalGet.call(this,this===localStorage&&scoped.has(name)?prefix+name:name)};
 Storage.prototype.setItem=function(name,value){return originalSet.call(this,this===localStorage&&scoped.has(name)?prefix+name:name,value)};
 Storage.prototype.removeItem=function(name){return originalRemove.call(this,this===localStorage&&scoped.has(name)?prefix+name:name)};
 localStorage.setItem('cli-proxy-auth',JSON.stringify({state:{apiBase:location.origin+'/api/cpa/console',managementKey:'nexus-session',rememberPassword:true},version:0}));
 localStorage.setItem('isLoggedIn','true');localStorage.setItem('cli-proxy-language','zh-CN');
 const rewrite=value=>{try{const u=new URL(String(value),location.href);if(u.origin===location.origin&&/^\\/(?:v[08]\\/management(?:\\/|$)|v0\\/resource\\/plugins\\/)/.test(u.pathname))u.pathname='/api/cpa/console'+u.pathname;return u.href}catch{return value}};
 const originalFetch=window.fetch.bind(window);window.fetch=(input,options)=>originalFetch(input instanceof Request?new Request(rewrite(input.url),input):rewrite(input),options);
 const originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){return originalOpen.call(this,method,rewrite(url),...rest)};
})();</script>`

export function adaptNativeConsoleHtml(bytes: Uint8Array, allowFragment = false): Uint8Array {
  let html: string
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new CpaClientError('invalid_response', '原版控制台不是有效 HTML', 502) }
  if (allowFragment && !/<head[\s>]/i.test(html)) return new TextEncoder().encode(CONSOLE_BOOTSTRAP + html)
  if (!/<html[\s>]/i.test(html) || !/<head[\s>]/i.test(html)) throw new CpaClientError('invalid_response', 'CPA 未返回原版控制台 HTML', 502)
  return new TextEncoder().encode(html.replace(/(<head\b[^>]*>)/i, '$1' + CONSOLE_BOOTSTRAP))
}

export function adaptNativePluginAsset(bytes: Uint8Array, contentType: string): Uint8Array {
  if (!/^(?:text\/html|text\/css|text\/javascript|application\/(?:javascript|x-javascript))(?:;|$)/i.test(contentType)) return bytes
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return bytes }
  source = source.replaceAll('/v0/resource/plugins/', '/api/cpa/console/v0/resource/plugins/')
  const result = new TextEncoder().encode(source)
  return /^text\/html(?:;|$)/i.test(contentType) ? adaptNativeConsoleHtml(result, true) : result
}

export async function proxyCpaConsole(event: H3Event) {
  await requireAdmin(event)
  const target = event.node.req.url || ''
  const question = target.indexOf('?'), pathname = question < 0 ? target : target.slice(0, question)
  if (!pathname.startsWith(PREFIX)) throw createError({ statusCode: 400, message: '原版控制台路径无效' })
  let relativePath = pathname.slice(PREFIX.length)
  // Some upstream resource scripts prepend their saved API base to absolute
  // resource paths. Canonicalize that duplicated base within this fixed scope.
  for (let depth = 0; depth < 3 && relativePath.startsWith('api/cpa/console/'); depth++) relativePath = relativePath.slice('api/cpa/console/'.length)
  const path = cpaPathSegments(relativePath).join('/')
  if (Number(getHeader(event, 'content-length')) > MAX_BODY_BYTES) throw createError({ statusCode: 413, message: 'CPA 请求体过大' })
  const downstream = cpaDownstreamAbort(event)
  try {
    const raw = ['GET', 'HEAD'].includes(event.method) ? undefined : await readRawBody(event, false)
    if (raw && raw.byteLength > MAX_BODY_BYTES) throw createError({ statusCode: 413, message: 'CPA 请求体过大' })
    let method = event.method, body = raw ? new Uint8Array(raw).buffer : undefined
    const reserved = process.env.CPA_CLIENT_KEY?.trim()
    if (path === 'v0/management/api-keys' && reserved && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
      let input: unknown
      if (method !== 'DELETE') {
        try { input = JSON.parse(raw?.toString('utf8') || '') } catch { throw createError({ statusCode: 400, message: 'CPA 客户端密钥格式无效' }) }
      }
      if (method === 'PUT') {
        const keys = Array.isArray(input) ? input : input && typeof input === 'object' ? (input as { items?: unknown }).items : undefined
        if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw createError({ statusCode: 400, message: 'CPA 客户端密钥格式无效' })
        body = new TextEncoder().encode(JSON.stringify([...new Set([...keys, reserved])])).buffer
      } else {
        const patch = input && typeof input === 'object' ? input as Record<string, unknown> : {}
        const query = new URLSearchParams(question < 0 ? '' : target.slice(question + 1))
        let removingReserved = method === 'DELETE' ? query.get('value')?.trim() === reserved : patch.old === reserved && patch.new !== reserved
        const index = method === 'DELETE' ? Number.parseInt(query.get('index') || '', 10) : patch.index
        if (Number.isInteger(index) && Number(index) >= 0 && (method === 'DELETE' || typeof patch.value === 'string')) {
          const current = await createCpaClient().request({ path: 'config/access/api-keys', signal: downstream.signal })
          let keys: unknown
          try { keys = JSON.parse(new TextDecoder().decode(current.body)) } catch { /* Fail closed rather than allowing an unverified index. */ }
          if (current.status !== 200 || !Array.isArray(keys)) throw createError({ statusCode: 502, message: '无法核对 CPA 内部访问密钥' })
          if (Number(index) < keys.length) removingReserved = keys[Number(index)] === reserved && (method === 'DELETE' || patch.value !== reserved)
        }
        if (removingReserved) throw createError({ statusCode: 409, message: '平台内部访问密钥用于连接 CPA，不能从客户端列表移除' })
      }
    }
    if (path === 'v8/management/config/access/api-keys' && reserved && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
      let keys: unknown = []
      if (method !== 'DELETE') {
        try { keys = JSON.parse(raw?.toString('utf8') || '') } catch { /* Reject malformed input below. */ }
        if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))) throw createError({ statusCode: 400, message: 'CPA 客户端密钥格式无效' })
      }
      body = new TextEncoder().encode(JSON.stringify([...new Set([...(keys as string[]), reserved])])).buffer
      method = 'PUT'
    }
    const response = await createCpaClient().consoleRequest({ path, method, query: new URLSearchParams(question < 0 ? '' : target.slice(question + 1)), body, headers: { 'content-type': getHeader(event, 'content-type') || 'application/json', accept: getHeader(event, 'accept') || '*/*' }, signal: downstream.signal })
    if (path.startsWith('v0/resource/plugins/')) {
      response.body = adaptNativePluginAsset(response.body, response.headers.get('content-type') || '')
      response.headers.delete('etag'); response.headers.delete('last-modified')
    }
    setResponseStatus(event, response.status)
    for (const [key, value] of response.headers) setHeader(event, key, value)
    return send(event, Buffer.from(response.body))
  } catch (error) {
    if (error instanceof CpaClientError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code, message: error.message } })
    throw error
  } finally { downstream.dispose() }
}

let panelCache: { bytes: Uint8Array; until: number } | undefined
export function resetNativePanelCache() { panelCache = undefined }
export async function serveCpaNativePanel(event: H3Event) {
  await requireAdmin(event)
  const downstream = cpaDownstreamAbort(event)
  try {
    if (!panelCache || panelCache.until <= Date.now()) {
      const response = await createCpaClient({ timeoutMs: 120_000 }).nativePanelRequest(downstream.signal)
      if (response.status !== 200) throw createError({ statusCode: response.status === 404 ? 503 : 502, message: '原版控制台暂不可用，请检查原生控制台设置及面板资产是否安装' })
      panelCache = { bytes: adaptNativeConsoleHtml(response.body), until: Date.now() + 5 * 60_000 }
    }
    setHeader(event, 'content-type', 'text/html; charset=utf-8')
    setHeader(event, 'cache-control', 'no-store')
    setHeader(event, 'x-nexus-upstream', 'cpa')
    return send(event, Buffer.from(panelCache.bytes))
  } catch (error) {
    if (error instanceof CpaClientError) throw createError({ statusCode: error.statusCode, message: error.message })
    throw error
  } finally { downstream.dispose() }
}
