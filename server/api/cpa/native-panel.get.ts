import { defineEventHandler } from 'h3'
import { serveCpaNativePanel } from '../../lib/cpa/console'
export default defineEventHandler(serveCpaNativePanel)
