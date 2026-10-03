import { defineEventHandler, getHeader, getRequestURL, createError, setHeader } from 'h3'
import { requireAdmin, requireServiceKey } from '../lib/auth'
export default defineEventHandler(async event => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return
  // The bundled Phosphor icons are public static assets, including on the login
  // page. SSR icon requests do not have an administrator session.
  if (['GET', 'HEAD'].includes(event.method) && ['/api/_nuxt_icon/ph', '/api/_nuxt_icon/ph.json'].includes(path)) return
  setHeader(event, 'Cache-Control', 'no-store')
  if (path.startsWith('/api/external/')) {
    await requireServiceKey(event)
    return
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.method)) {
    const origin = getHeader(event, 'origin')
    if (origin) {
      let allowed = false
      try {
        const source = new URL(origin)
        const target = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true })
        allowed = ['http:', 'https:'].includes(source.protocol) && source.origin === target.origin
      } catch { /* Opaque or malformed origins are invalid requests, not server errors. */ }
      if (!allowed) throw createError({ statusCode: 403, message: '请求来源不匹配' })
    }
  }
  if (['/api/auth/session', '/api/auth/login'].includes(path)) return
  await requireAdmin(event)
})
