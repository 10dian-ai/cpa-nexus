import { defineEventHandler } from 'h3'
import { intakeModuleViews } from '../../lib/intake/request'

/** Every module that accepts account intake, for the admin import dialogs. */
export default defineEventHandler(async () => ({ modules: await intakeModuleViews() }))
