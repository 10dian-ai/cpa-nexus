import { computed, onScopeDispose, ref, watch } from 'vue'
import type { JobView } from '../../shared/types'
import { apiErrorMessage } from './useApiAction'

export function useImportJobProgress(load: (id: string, signal: AbortSignal) => Promise<JobView>, completed: () => unknown) {
  const job = ref<JobView | null>(null)
  const jobId = ref<string | null>(null)
  const jobError = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let stopped = false
  const jobRunning = computed(() => !!jobId.value && !['completed', 'failed'].includes(job.value?.status || ''))
  const jobPercent = computed(() => job.value?.progress.total ? Math.min(100, Math.round(job.value.progress.processed / job.value.progress.total * 100)) : 0)
  function cancel() {
    if (timer) clearTimeout(timer)
    timer = undefined
    request?.abort()
    request = undefined
  }
  async function pollJob() {
    const id = jobId.value
    if (!id || stopped) return
    cancel()
    const current = new AbortController()
    request = current
    try {
      const result = await load(id, current.signal)
      if (current.signal.aborted || stopped || jobId.value !== id) return
      job.value = result
      jobError.value = ''
      if (jobRunning.value) timer = setTimeout(() => { void pollJob() }, 1800)
      else await completed()
    } catch (error) {
      if (!current.signal.aborted && !stopped && jobId.value === id) jobError.value = apiErrorMessage(error)
    } finally {
      if (request === current) request = undefined
    }
  }
  watch(jobId, () => {
    cancel()
    job.value = null
    jobError.value = ''
    if (jobId.value) void pollJob()
  }, { flush: 'sync' })
  onScopeDispose(() => { stopped = true; cancel() })
  return { job, jobId, jobError, jobRunning, jobPercent, pollJob }
}
