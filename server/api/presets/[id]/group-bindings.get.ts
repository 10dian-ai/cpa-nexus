import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { getGroupPreset } from '../../../lib/presets'
import { platformError } from '../../../lib/platform-error'

export default defineEventHandler(async event => {
  const groupId = getQuery(event).groupId
  if (typeof groupId !== 'string' || !groupId) throw platformError({ statusCode: 400, message: '请选择有效分组' })
  return getGroupPreset(groupId, getRouterParam(event, 'id') || '')
})
