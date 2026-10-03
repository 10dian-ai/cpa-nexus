import { createError, defineEventHandler, setHeader, setResponseStatus } from 'h3'
import { CpaClientError, readCpaResponseBody, validateCpaBaseUrl } from '../../lib/cpa/client'
export default defineEventHandler(async event => {
  setHeader(event, 'X-Nexus-Upstream', 'cpa')
  const key = process.env.CPA_CLIENT_KEY?.trim()
  if (!key) throw createError({ statusCode: 503, message: '尚未配置 CPA_CLIENT_KEY，请先完成 CPA 初始化',
    data: { code: 'not_configured', message: '尚未配置 CPA_CLIENT_KEY，请先完成 CPA 初始化' } })
  if (/[\r\n]/.test(key)) throw createError({ statusCode: 503, message: 'CPA_CLIENT_KEY 配置无效', data: { code: 'invalid_configuration', message: 'CPA_CLIENT_KEY 配置无效' } })
  let url: URL
  try {
    url = new URL('/v1/models', validateCpaBaseUrl(process.env.CPA_URL?.trim() || 'http://cpa:8317'))
  } catch { throw createError({ statusCode: 503, message: 'CPA 地址配置无效', data: { code: 'invalid_configuration', message: 'CPA 地址配置无效' } }) }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new CpaClientError('timeout', '读取 CPA 模型目录超时', 504))
    }, 8000)
  })
  try {
    const operation = async () => {
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + key }, redirect: 'error', signal: controller.signal })
      const body = await readCpaResponseBody(response)
      return { response, body }
    }
    const { response, body } = await Promise.race([operation(), timeout])
    setResponseStatus(event, response.status)
    setHeader(event, 'cache-control', 'no-store')
    setHeader(event, 'content-type', response.headers.get('content-type') || 'application/json')
    return Buffer.from(body)
  } catch (error) {
    if (error instanceof CpaClientError) throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code, message: error.message } })
    const message = controller.signal.aborted ? '读取 CPA 模型目录超时' : '无法读取 CPA 实际模型目录，请检查核心连接'
    throw createError({ statusCode: controller.signal.aborted ? 504 : 502, message, data: { code: controller.signal.aborted ? 'timeout' : 'unreachable', message } })
  } finally { if (timer) clearTimeout(timer) }
})
