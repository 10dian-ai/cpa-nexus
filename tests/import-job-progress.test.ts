import { effectScope, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobView } from '../shared/types'
import { useImportJobProgress } from '../app/composables/useImportJobProgress'

const view = (id: string, status = 'active'): JobView => ({
  id, status, progress: { processed: status === 'completed' ? 10 : 3, total: 10 }, result: null, error: null,
})
let scope: EffectScope | undefined
beforeEach(() => vi.useFakeTimers())
afterEach(() => { scope?.stop(); vi.useRealTimers() })
function fixture(load = vi.fn<(id: string, signal: AbortSignal) => Promise<JobView>>()) {
  const completed = vi.fn()
  scope = effectScope()
  const state = scope.run(() => useImportJobProgress(load, completed))!
  return { ...state, load, completed }
}
describe('import progress lifecycle', () => {
  it('polls until completion then refreshes the account list once', async () => {
    const { jobId, load, jobPercent, jobRunning, completed } = fixture()
    load.mockResolvedValueOnce(view('first')).mockResolvedValueOnce(view('first', 'completed'))
    jobId.value = 'first'
    await vi.advanceTimersByTimeAsync(0)
    expect(jobPercent.value).toBe(30)
    expect(jobRunning.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1800)
    expect(jobPercent.value).toBe(100)
    expect(jobRunning.value).toBe(false)
    expect(completed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('shows read failures and permits an explicit retry', async () => {
    const { jobId, load, jobError, pollJob } = fixture()
    load.mockRejectedValueOnce({ data: { statusMessage: 'Job expired' } })
    jobId.value = 'first'
    await vi.advanceTimersByTimeAsync(0)
    expect(jobError.value).toBe('Job expired')
    load.mockResolvedValueOnce(view('first', 'completed'))
    await pollJob()
    expect(jobError.value).toBe('')
  })
  it('cancels an old poll and ignores its late result when starting a new import', async () => {
    const { jobId, job, load } = fixture()
    let finishOld!: (value: JobView) => void
    load.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce(view('second'))
    jobId.value = 'first'
    const oldSignal = load.mock.calls[0]![1]
    jobId.value = 'second'
    expect(oldSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    finishOld(view('first', 'completed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(job.value?.id).toBe('second')
    expect(job.value?.status).toBe('active')
  })
  it('cancels the active request and discards late results when progress is dismissed', async () => {
    const { jobId, job, jobError, load } = fixture()
    let reject!: (error: Error) => void
    load.mockImplementationOnce(() => new Promise((_resolve, rejectRequest) => { reject = rejectRequest }))
    jobId.value = 'first'
    const signal = load.mock.calls[0]![1]
    jobId.value = null
    expect(signal.aborted).toBe(true)
    reject(new Error('Late error'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(job.value).toBeNull()
    expect(jobError.value).toBe('')
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('cleans up outstanding requests when leaving the page', () => {
    const { jobId, load } = fixture()
    load.mockImplementationOnce(() => new Promise(() => {}))
    jobId.value = 'first'
    const signal = load.mock.calls[0]![1]
    scope!.stop()
    expect(signal.aborted).toBe(true)
  })
})
