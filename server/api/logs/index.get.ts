import { defineEventHandler, getQuery } from 'h3'
import { getDb } from '../../lib/db'
import { pagination } from '../../lib/http'
import { redactLogFields } from '../../lib/logs'
import { redactSensitiveText } from '../../../shared/log-privacy'
export default defineEventHandler(async event => {
  const query = getQuery(event); const { page, pageSize, offset } = pagination(query)
  const model = String(query.model ?? '').slice(0, 200)
  const status = ['success','error','cancelled','incomplete'].includes(String(query.status)) ? String(query.status) : ''
  const db = getDb()
  const pattern = '%' + model.replace(/[\\%_]/g, '\\$&') + '%'
  const safePattern = '%' + redactSensitiveText(model).replace(/[\\%_]/g, '\\$&') + '%'
  const condition = db`WHERE (${model}='' OR l.model ILIKE ${pattern} OR l.model ILIKE ${safePattern}) AND (${status}='' OR l.status=${status})`
  const [rows, count] = await Promise.all([
    db`SELECT l.id,l.account_id,l.module_id,l.source_id,a.label AS account_label,k.name AS key_name,l.model,l.protocol,l.status,l.http_status,l.duration_ms,l.streaming,l.usage,l.error_message,l.response_truncated,l.created_at
      FROM request_logs l LEFT JOIN managed_accounts a ON a.id=l.account_id LEFT JOIN gateway_keys k ON k.id=l.key_id ${condition} ORDER BY l.created_at DESC,l.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    db`SELECT count(*)::int AS total FROM request_logs l ${condition}`,
  ])
  return { items: rows.map(r => redactLogFields({ id:r.id,accountId:r.account_id || r.source_id || null,moduleId:r.module_id || null,sourceId:r.source_id || null,accountLabel:r.account_label,keyName:r.key_name,model:r.model,protocol:r.protocol,status:r.status,httpStatus:r.http_status,
    durationMs:r.duration_ms,streaming:r.streaming,usage:r.usage,errorMessage:r.error_message,responseTruncated:r.response_truncated,createdAt:new Date(r.created_at).toISOString() })), total:count[0]!.total,page,pageSize }
})
