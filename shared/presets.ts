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
  sourceJson: Record<string, unknown>
  variables: Record<string, string>
  compatibility: PresetCompatibility
  createdAt: string
  updatedAt: string
}
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
  moduleId: 'commandcode' | 'cpa'
  mode: 'preset' | 'bypass'
  presetId: string | null
  updatedAt: string
}
export interface KeyPresetRouteInput {
  keyId: string
  mode: 'inherit' | 'preset' | 'bypass'
  presetId?: string | null
}
export type PresetProtocol = 'chat' | 'messages' | 'responses'
export interface PresetApplyOptions {
  protocol: PresetProtocol
  context?: Record<string, string>
  generationType?: 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet'
}
export const PRESET_MAX_BYTES = 1024 * 1024
export const PRESET_CONTEXT_KEYS = [
  'user', 'char', 'charIfNotGroup', 'description', 'personality', 'scenario', 'persona',
  'mesExamples', 'wiBefore', 'wiAfter', 'original', 'group', 'model',
] as const
