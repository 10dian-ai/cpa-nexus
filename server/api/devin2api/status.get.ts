import { defineEventHandler } from 'h3'
import { getDevinStatus } from '../../lib/devin2api/admin'
export default defineEventHandler(() => getDevinStatus())
