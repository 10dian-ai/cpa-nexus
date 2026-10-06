import { defineEventHandler } from 'h3'
import { listDevinModels } from '../../lib/devin2api/admin'
export default defineEventHandler(() => listDevinModels())
