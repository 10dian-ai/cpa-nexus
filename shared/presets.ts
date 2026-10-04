import type { ModelModuleId } from './keys'
export interface PresetIssue {
  code: string
  severity: 'warning' | 'error'
  message: string
  path?: string
}
export interface PresetCompatibility { supported: boolean; issues: PresetIssue[] }
export interface PresetView {
  id: string
  name: string
  description: string
  enabled: boolean
  sortOrder: number
  sourceJson: Record<string, unknown>
  variables: Record<string, string>
  compatibility: PresetCompatibility
  createdAt: string
  updatedAt: string
}
export type PresetSummary = Pick<PresetView, 'id' | 'name' | 'enabled' | 'sortOrder' | 'createdAt' | 'updatedAt'>
export interface PresetBinding {
  moduleId: string
  accountId: string | null
  mode: 'preset' | 'bypass'
  presetId: string | null
  updatedAt: string
}
export interface PresetRouteInput {
  moduleId: string
  accountId?: string | null
  mode: 'inherit' | 'preset' | 'bypass'
  presetId?: string | null
}
export interface KeyPresetBinding {
  keyId: string
  moduleId: ModelModuleId
  mode: 'preset' | 'stack' | 'bypass'
  presetId: string | null
  updatedAt: string
}
export interface KeyPresetRouteInput {
  keyId: string
  mode: 'inherit' | 'preset' | 'stack' | 'bypass'
  presetId?: string | null
}
export type PresetProtocol = 'chat' | 'messages' | 'responses'
export interface PresetApplyOptions {
  protocol: PresetProtocol
  context?: Record<string, string>
  generationType?: 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet'
}
/** Preset documents have no application-imposed size limit. */
export const PRESET_MAX_BYTES = Number.POSITIVE_INFINITY
export const PRESET_CONTEXT_KEYS = [
  'user', 'char', 'charIfNotGroup', 'description', 'personality', 'scenario', 'persona',
  'mesExamples', 'wiBefore', 'wiAfter', 'original', 'group', 'model',
] as const
