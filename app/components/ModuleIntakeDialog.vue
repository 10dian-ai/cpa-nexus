<script setup lang="ts">
import type { IntakeModuleView, IntakeSubmitResult } from '#shared/intake'
import type { RoutingGroupView } from '#shared/groups'
import type { JobView } from '#shared/types'

/**
 * Admin account import for one module. Uses the same parser, queue and worker
 * as the external service API and the public intake page on port 3041.
 */
const props = defineProps<{ moduleId: string }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ imported: [] }>()
const api = useRequestFetch()
const { data: intake } = await useFetch<{ modules: IntakeModuleView[] }>('/api/modules/intake', { key: 'nexus-intake-modules' })
const { data: groups } = await useFetch<{ items: RoutingGroupView[]; moduleDefaultGroupIds?: Record<string, string> }>('/api/groups', { key: 'nexus-routing-groups' })
const module = computed(() => intake.value?.modules.find(item => item.id === props.moduleId))
const text = ref('')
const files = ref<File[]>([])
const groupIds = ref<string[]>([])
const result = ref<IntakeSubmitResult | null>(null)
const { busy, run } = useApiAction()
const { job, jobId, jobError, jobRunning, jobPercent } = useImportJobProgress((id, signal) => api<JobView>('/api/jobs/' + id, { signal }), () => emit('imported'))
watch(open, value => {
  if (!value) return
  text.value = ''; files.value = []; result.value = null; jobId.value = null
  const fallback = groups.value?.moduleDefaultGroupIds?.[props.moduleId]
  groupIds.value = fallback ? [fallback] : []
})
function pick(event: Event) { files.value = Array.from((event.target as HTMLInputElement).files || []) }
async function submit() {
  const payload = { ...(text.value.trim() ? { text: text.value } : {}), files: await Promise.all(files.value.map(async file => ({ name: file.name, content: await file.text() }))), ...(groupIds.value.length ? { groupIds: [...groupIds.value] } : {}) }
  const response = await run(() => api<IntakeSubmitResult>(`/api/modules/${props.moduleId}/import`, { method: 'POST', body: payload }))
  if (response.ok) { result.value = response.value; if (response.value.accepted) jobId.value = response.value.jobId }
}
const canSubmit = computed(() => !busy.value && !jobRunning.value && (!!text.value.trim() || files.value.length > 0))
const issues = computed(() => [...(result.value?.errors || []), ...(job.value?.result?.errors || [])])
</script>

<template>
  <AppDialog v-model="open" wide :title="'导入账号 · ' + (module?.name || moduleId)" :description="module?.description" :close-disabled="busy">
    <form id="module-intake-form" class="form-stack" @submit.prevent="submit">
      <details v-if="module?.formats.length" class="raw-details"><summary><UIcon name="i-ph-info-bold" />支持的格式（自动识别，可混合粘贴）</summary>
        <dl class="nexus-definition-list intake-formats"><div v-for="format in module.formats" :key="format.id"><dt>{{ format.label }}</dt><dd>{{ format.description }}<code class="mono">{{ format.example }}</code></dd></div></dl>
      </details>
      <label class="field"><span>粘贴账号</span><textarea v-model="text" rows="9" class="nexus-code-editor" spellcheck="false" placeholder="每行一个，或粘贴 JSON" :disabled="busy" /></label>
      <label class="field"><span>上传文件 <small>可多选</small></span><input type="file" multiple :accept="module?.accept" :disabled="busy" @change="pick"><small v-if="files.length">已选择 {{ files.length }} 个文件</small></label>
      <GroupSelector v-model="groupIds" :groups="groups?.items || []" :disabled="busy" description="新账号加入这些分组；不选则进入该模块的默认分组。已存在的账号保留原分组。" />
    </form>
    <section v-if="result" class="job-panel section-gap">
      <div class="panel-heading"><h2>{{ job?.status === 'completed' ? '导入完成' : result.accepted ? '正在导入' : '没有需要导入的账号' }}</h2><span class="small-text muted">排队 {{ result.accepted }} · 格式错误 {{ result.rejected }} · 重复 {{ result.duplicates }}</span></div>
      <div v-if="result.accepted" class="job-progress"><progress :value="jobPercent" max="100" /><span>{{ job?.progress.processed || 0 }} / {{ job?.progress.total || result.accepted }}</span></div>
      <p v-if="job?.result">新增 {{ job.result.imported }} · 更新 {{ job.result.updated }} · 跳过 {{ job.result.skipped }} · 失败 {{ job.result.failed }}</p>
      <p v-if="jobError" class="inline-error">{{ jobError }}</p>
      <div v-if="issues.length" class="job-errors"><p v-for="issue in issues.slice(0, 200)" :key="issue.line + issue.message">第 {{ issue.line }} 条：{{ issue.message }}</p></div>
    </section>
    <template #footer><button class="button" :disabled="busy" @click="open = false">关闭</button><button form="module-intake-form" class="button primary" :disabled="!canSubmit"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />提交导入</button></template>
  </AppDialog>
</template>
