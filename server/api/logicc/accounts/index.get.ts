import { defineEventHandler, getQuery } from 'h3'
import { pagination } from '../../../lib/http'
import { listAccounts } from '../../../modules/logicc/store'

export default defineEventHandler(async event => {
  const query = getQuery(event)
  const { page, pageSize } = pagination(query)
  const text = (value: unknown, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : ''
  const status = ['pending', 'ready', 'credential_expired', 'sync_error'].includes(String(query.status)) ? String(query.status) : ''
  const groupId = /^[0-9a-f-]{36}$/i.test(String(query.groupId)) ? String(query.groupId) : ''
  return listAccounts({ q: text(query.q), status, groupId, page, pageSize })
})
