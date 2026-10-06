import { defineEventHandler } from 'h3'
import { listDevinAccounts } from '../../../lib/devin2api/admin'
export default defineEventHandler(() => listDevinAccounts())
