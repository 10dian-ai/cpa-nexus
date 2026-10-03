import { defineEventHandler } from 'h3'
import { connectCommandcodeBridge } from '../../../lib/commandcode-bridge'
export default defineEventHandler(connectCommandcodeBridge)
