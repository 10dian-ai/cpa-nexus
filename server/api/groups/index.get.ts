import { defineEventHandler } from 'h3'
import { listGroups } from '../../lib/groups'
import { DEFAULT_GROUP_ID } from '../../../shared/groups'
export default defineEventHandler(async () => ({ items: await listGroups(), defaultGroupId: DEFAULT_GROUP_ID }))
