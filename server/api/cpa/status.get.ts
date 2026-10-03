import { defineEventHandler } from 'h3'
import { createCpaClient } from '../../lib/cpa/client'

export default defineEventHandler(() => createCpaClient().status())
