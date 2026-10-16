import { defineEventHandler, getQuery } from 'h3'
import { getDb } from '../../lib/db'
import { pagination } from '../../lib/http'
import { redactLogFields } from '../../lib/logs'
import { LOG_SOURCE_FILTERS, sourceLabels } from '../../lib/log-sources'
import { redactSensitiveText } from '../../../shared/log-privacy'
export default defineEventHandler(async event => {
  const query = getQuery(event); const { page, pageSize, offset } = pagination(query)
  const model = String(query.model ?? '').slice(0, 200)
  const status = ['success','error','cancelled','incomplete'].includes(String(query.status)) ? String(query.status) : ''
  // Source filter: the module that served the request (CPA kernel or a pool module).
  const source = (LOG_SOURCE_FILTERS as readonly string[]).includes(String(query.source)) ? String(query.source) : ''
  const db = getDb()
  const pattern = '%' + model.replace(/[\\%_]/g, '\\$&') + '%'
  const safePattern = '%' + redactSensitiveText(model).replace(/[\\%_]/g, '\\$&') + '%'
  const condition = db`WHERE (${model}='' OR l.model ILIKE ${pattern} OR l.model ILIKE ${safePattern}) AND (${status}='' OR l.status=${status})
    AND (${source}='' OR l.module_id=${source})`
  const [rows, count] = await Promise.all([
    db`SELECT l.id,l.module_id,l.source_id,k.name AS key_name,l.model,l.protocol,l.status,l.http_status,l.duration_ms,l.streaming,l.usage,l.error_message,l.response_truncated,l.created_at
      FROM request_logs l LEFT JOIN gateway_keys k ON k.id=l.key_id ${condition} ORDER BY l.created_at DESC,l.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    db`SELECT count(*)::int AS total FROM request_logs l ${condition}`,
  ])
  const labels = await sourceLabels(rows)
  return { items: rows.map(r => redactLogFields({ id:r.id,moduleId:r.module_id || null,sourceId:r.source_id || null,sourceLabel:r.source_id ? labels.get(String(r.source_id)) ?? null : null,
    keyName:r.key_name,model:r.model,protocol:r.protocol,status:r.status,httpStatus:r.http_status,
    durationMs:r.duration_ms,streaming:r.streaming,usage:r.usage,errorMessage:r.error_message,responseTruncated:r.response_truncated,createdAt:new Date(r.created_at).toISOString() })), total:count[0]!.total,page,pageSize }
})
