import { DEFAULT_SETTINGS, type SystemSettings } from '../../shared/types'

export const UPSTREAM_TIMEOUT_LIMITS = { min: 30, max: 7200 } as const

/**
 * Milliseconds of upstream silence tolerated by every model forwarding path
 * (CPA native sources and the pool-module bridges such as Logicc). Long
 * non-streaming reasoning requests can be silent for minutes, so the default
 * is 600 seconds. A missing or invalid value falls back to the default.
 */
export function upstreamIdleTimeoutMs(settings: Partial<SystemSettings>): number {
  const seconds = Number(settings.upstreamTimeoutSeconds)
  return (Number.isFinite(seconds) && seconds >= UPSTREAM_TIMEOUT_LIMITS.min ? seconds : DEFAULT_SETTINGS.upstreamTimeoutSeconds) * 1000
}
