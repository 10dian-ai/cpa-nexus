import { defineEventHandler } from 'h3'
import { proxyCpaPlugin } from '../../../lib/cpa/http'

export default defineEventHandler(event => proxyCpaPlugin(event, 'resource'))
