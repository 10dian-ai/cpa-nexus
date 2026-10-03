import { defineEventHandler } from 'h3'
import { handleCommandcodeCompatibility } from '../../../lib/commandcode-compat'

export default defineEventHandler(handleCommandcodeCompatibility)
