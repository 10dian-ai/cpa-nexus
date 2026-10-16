import { platformError } from '../lib/platform-error'
import { isPoolModuleId, type PoolModuleId } from '../../shared/modules'
import { isIntakeModuleId, type IntakeModuleId } from '../../shared/intake'
import type { PoolModule } from './contract'
import type { IntakeHandler } from '../lib/intake/contract'
import { logiccModule } from './logicc'
import { logiccIntake } from './logicc/intake'
import { cpaIntake } from '../lib/cpa/intake'

/** Account-pool modules by id. New pool modules register here. */
const POOL_MODULES: Record<PoolModuleId, PoolModule> = { logicc: logiccModule }
export function poolModule(id: string): PoolModule {
  if (!isPoolModuleId(id)) throw platformError({ statusCode: 404, message: '模块不存在' })
  return POOL_MODULES[id]
}
export function poolModules(): PoolModule[] { return Object.values(POOL_MODULES) }

/** Intake handlers by id: the pool modules plus the CPA kernel's credential upload. */
const INTAKE_HANDLERS: Record<IntakeModuleId, IntakeHandler> = { logicc: logiccIntake, cpa: cpaIntake }
export function intakeHandler(id: string): IntakeHandler {
  if (!isIntakeModuleId(id)) throw platformError({ statusCode: 404, message: '模块不存在或不支持远程加号' })
  return INTAKE_HANDLERS[id]
}
export function intakeHandlers(): IntakeHandler[] { return Object.values(INTAKE_HANDLERS) }
