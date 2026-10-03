import { CpaClientError, cpaPathSegments, validateCpaBaseUrl, type CpaRequest } from './client'

export interface CpaPluginRequest extends CpaRequest { kind: 'resource' | 'management' }

/** Trusted server manifest: exact paths only, never URL prefixes or wildcards. */
export interface CpaPluginRoute {
  pluginId: string
  kind: 'resource' | 'management'
  /** Full CPA path under /v0/resource/plugins/<pluginId>/ or /v0/management/. */
  path: string
  methods: string[]
  query?: string[]
}

interface Plugin { id: string; effective_enabled: boolean; menus?: { path: string }[] }
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const RESOURCE_PREFIX = '/v0/resource/plugins/'
const MANAGEMENT_PREFIX = '/v0/management/'

export function parseCpaPluginRoutes(value = process.env.CPA_PLUGIN_ROUTES || ''): CpaPluginRoute[] {
  if (!value.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new CpaClientError('invalid_configuration', 'CPA_PLUGIN_ROUTES 必须是有效 JSON', 503) }
  if (!Array.isArray(parsed) || parsed.length > 256) throw new CpaClientError('invalid_configuration', 'CPA_PLUGIN_ROUTES 必须是路由数组', 503)
  return parsed.map(item => {
    if (!item || typeof item !== 'object' || typeof item.pluginId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.pluginId)
      || !['resource', 'management'].includes(item.kind) || typeof item.path !== 'string'
      || !Array.isArray(item.methods) || !item.methods.length || item.methods.some((method: unknown) => typeof method !== 'string' || !METHODS.includes(method))
      || (item.query !== undefined && (!Array.isArray(item.query) || item.query.some((key: unknown) => typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key))))) {
      throw new CpaClientError('invalid_configuration', 'CPA_PLUGIN_ROUTES 含有无效路由声明', 503)
    }
    const prefix = item.kind === 'resource' ? RESOURCE_PREFIX + item.pluginId + '/' : MANAGEMENT_PREFIX
    if (!item.path.startsWith(prefix)) throw new CpaClientError('invalid_configuration', 'CPA 插件路由超出声明范围', 503)
    let segments: string[]
    try { segments = cpaPathSegments(item.path.slice(1)) }
    catch { throw new CpaClientError('invalid_configuration', 'CPA 插件路由路径无效', 503) }
    if (segments.some(segment => segment.includes('*') || segment.includes(':'))) throw new CpaClientError('invalid_configuration', 'CPA 插件路由仅支持精确路径', 503)
    if (item.kind === 'resource' && item.methods.some((method: string) => !['GET', 'HEAD'].includes(method))) {
      throw new CpaClientError('invalid_configuration', 'CPA 插件资源只支持读取', 503)
    }
    return { pluginId: item.pluginId, kind: item.kind, path: '/' + segments.map(encodeURIComponent).join('/'), methods: item.methods, query: item.query || [] }
  })
}

export function resolveCpaPluginRequest(baseUrl: string, request: CpaPluginRequest, discovery: unknown, manifest?: CpaPluginRoute[]) {
  const base = validateCpaBaseUrl(baseUrl)
  const segments = cpaPathSegments(request.path)
  const path = (request.kind === 'resource' ? RESOURCE_PREFIX : MANAGEMENT_PREFIX) + segments.map(encodeURIComponent).join('/')
  const method = (request.method || 'GET').toUpperCase()
  if (!METHODS.includes(method) || (request.kind === 'resource' && !['GET', 'HEAD'].includes(method))) {
    throw new CpaClientError('unsupported_method', 'CPA 插件接口不支持该请求方法', 405)
  }
  if (!discovery || typeof discovery !== 'object' || !Array.isArray((discovery as { plugins?: unknown }).plugins)) {
    throw new CpaClientError('invalid_response', 'CPA 插件发现接口返回无效响应', 502)
  }
  const plugins = ((discovery as { plugins: unknown[] }).plugins).filter((item): item is Plugin => Boolean(item && typeof item === 'object'
    && typeof (item as Plugin).id === 'string' && (item as Plugin).effective_enabled === true))
  const enabled = new Set(plugins.map(plugin => plugin.id))
  const declarations = manifest === undefined ? parseCpaPluginRoutes() : parseCpaPluginRoutes(JSON.stringify(manifest))
  const declared = declarations.find(route => route.kind === request.kind && route.path === path && enabled.has(route.pluginId))
  const menu = request.kind === 'resource' && plugins.some(plugin => plugin.id === segments[0]
    && Array.isArray(plugin.menus) && plugin.menus.some(item => item && item.path === path))
  if (!declared && !menu) throw new CpaClientError('unsupported_plugin_path', 'CPA 插件路由未声明或插件未启用', 404)
  if (declared && !declared.methods.includes(method)) throw new CpaClientError('unsupported_method', 'CPA 插件接口不支持该请求方法', 405)
  const query = request.query instanceof URLSearchParams ? request.query : new URLSearchParams(
    Object.entries(request.query || {}).map(([key, value]) => [key, String(value)]),
  )
  const seen = new Set<string>()
  for (const [key, value] of query) {
    if (!declared?.query?.includes(key) || seen.has(key) || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new CpaClientError('invalid_query', 'CPA 插件查询参数未声明或无效', 400)
    }
    seen.add(key)
  }
  if (query.toString().length > 16384) throw new CpaClientError('invalid_query', 'CPA 插件查询参数过长', 400)
  const url = new URL(path, base)
  url.search = query.toString()
  // CPA resource routes are registered as GET only; Nexus supports HEAD locally.
  return { url, method: request.kind === 'resource' && method === 'HEAD' ? 'GET' : method }
}
