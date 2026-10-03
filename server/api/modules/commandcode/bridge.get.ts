import { defineEventHandler } from 'h3'
import { getCommandcodeBridge } from '../../../lib/commandcode-bridge'
export default defineEventHandler(getCommandcodeBridge)
