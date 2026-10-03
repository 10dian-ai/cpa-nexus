<script setup lang="ts">
import { PRESET_CONTEXT_KEYS, type PresetView } from '#shared/presets'
definePageMeta({ key: route => route.params.id as string })
const route = useRoute(), api = useRequestFetch(), id = String(route.params.id)
const { data, pending, error, refresh } = await useFetch<PresetView>('/api/presets/' + encodeURIComponent(id), { key: 'nexus-preset-' + id })
const { busy, run } = useApiAction()
const source = shallowRef<Record<string, unknown>>({}), variables = shallowRef<Record<string, string>>({})
const name = ref(''), description = ref(''), dirty = ref(false), validation = ref('')
const checked = shallowRef<PresetView['compatibility'] | null>(null)
useHead({ title: computed(() => (name.value || '预设详情') + ' · CPA Nexus') })
function load(preset: PresetView) {
  source.value = JSON.parse(JSON.stringify(preset.sourceJson)); variables.value = { ...preset.variables }
  name.value = preset.name; description.value = preset.description; dirty.value = false; checked.value = null; validation.value = ''
}
watch(data, value => { if (value) load(value) }, { immediate: true })
function touch() { triggerRef(source); dirty.value = true; checked.value = null; validation.value = '' }
const tab = ref<'prompts' | 'sampling' | 'variables'>('prompts'), search = ref(''), filter = ref<'all' | 'enabled' | 'disabled'>('all')
const ambiguousOrder = computed(() => presetPromptOrderAmbiguous(source.value))
const rows = computed(() => ambiguousOrder.value ? [] : presetPromptRows(source.value))
const enabledCount = computed(() => rows.value.filter(row => row.enabled).length)
const visible = computed(() => {
  const query = search.value.trim().toLowerCase()
  return rows.value.filter(row => (filter.value === 'all' || row.enabled === (filter.value === 'enabled')) && (!query || row.name.toLowerCase().includes(query) || row.identifier.toLowerCase().includes(query)))
})
function toggle(row: PresetPromptRow, event: Event) { updatePresetPrompt(source.value, row, 'enabled', (event.target as HTMLInputElement).checked); touch() }
function move(row: PresetPromptRow, direction: -1 | 1) { movePresetPrompt(source.value, row.identifier, direction); touch() }
const promptOpen = ref(false), editing = shallowRef<PresetPromptRow | null>(null)
const promptName = ref(''), promptRole = ref('system'), promptContent = ref(''), contentInput = ref<HTMLTextAreaElement>()
const promptPosition = ref('0'), promptDepth = ref('4'), promptOrder = ref('100'), promptTriggers = ref<string[]>([]), originalAdvanced = ref('')
const generationTypes = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']
function definition(row: PresetPromptRow) {
  const list = presetDocumentSettings(source.value).prompts, item = Array.isArray(list) ? list[row.index] : null
  return item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
}
function editPrompt(row: PresetPromptRow) {
  editing.value = row; promptName.value = row.name; promptRole.value = row.role; promptContent.value = row.content
  const item = definition(row)
  promptPosition.value = String(item?.injection_position ?? 0); promptDepth.value = String(item?.injection_depth ?? 4); promptOrder.value = String(item?.injection_order ?? 100)
  promptTriggers.value = Array.isArray(item?.injection_trigger) ? [...item.injection_trigger] as string[] : []
  originalAdvanced.value = JSON.stringify([promptPosition.value, promptDepth.value, promptOrder.value, promptTriggers.value]); validation.value = ''; promptOpen.value = true
}
function applyPrompt() {
  const row = editing.value
  if (!row || row.index < 0) { promptOpen.value = false; return }
  if (!promptName.value.trim()) { validation.value = '请填写条目名称。'; return }
  const advancedChanged = originalAdvanced.value !== JSON.stringify([promptPosition.value, promptDepth.value, promptOrder.value, promptTriggers.value])
  if (advancedChanged && (!Number.isInteger(Number(promptDepth.value)) || Number(promptDepth.value) < 0 || !Number.isInteger(Number(promptOrder.value)))) { validation.value = '注入深度需为非负整数，优先级需为整数。'; return }
  updatePresetPrompt(source.value, row, 'name', promptName.value); updatePresetPrompt(source.value, row, 'role', promptRole.value)
  if (!row.marker) updatePresetPrompt(source.value, row, 'content', promptContent.value)
  const item = definition(row)
  if (item && advancedChanged) { item.injection_position = Number(promptPosition.value); item.injection_depth = Number(promptDepth.value); item.injection_order = Number(promptOrder.value); item.injection_trigger = [...promptTriggers.value] }
  touch(); promptOpen.value = false
}
async function insertMacro(key: string) {
  const input = contentInput.value, start = input?.selectionStart ?? promptContent.value.length, end = input?.selectionEnd ?? start, macro = '{{' + key + '}}'
  promptContent.value = promptContent.value.slice(0, start) + macro + promptContent.value.slice(end)
  await nextTick(); input?.focus(); input?.setSelectionRange(start + macro.length, start + macro.length)
}
const samplingOpen = ref(false), sampleKey = ref(''), sampleValue = ref<string | number>(''), sampleError = ref('')
const settings = computed(() => presetDocumentSettings(source.value))
const sampleField = computed(() => presetSamplingFields.find(field => field.key === sampleKey.value))
function editSampling(field: typeof presetSamplingFields[number]) { sampleKey.value = field.key; sampleValue.value = String(settings.value[presetSamplingKey(source.value, field)] ?? ''); sampleError.value = ''; samplingOpen.value = true }
function removeSampling(field: typeof presetSamplingFields[number]) { for (const key of [field.key, ...field.aliases]) delete settings.value[key]; touch() }
function toggleSampling(field: typeof presetSamplingFields[number], event: Event) { if ((event.target as HTMLInputElement).checked) editSampling(field); else removeSampling(field) }
function applySampling() {
  const field = sampleField.value
  if (!field) return
  if (!String(sampleValue.value).trim()) { removeSampling(field); samplingOpen.value = false; return }
  const value = Number(sampleValue.value)
  if (!Number.isFinite(value)) { sampleError.value = '请输入有效数值。'; return }
  settings.value[presetSamplingKey(source.value, field)] = value; touch(); samplingOpen.value = false
}
const variableOpen = ref(false), variableKey = ref(''), variableText = ref(''), oldVariableKey = ref('')
function editVariable(key = '') { oldVariableKey.value = key; variableKey.value = key || PRESET_CONTEXT_KEYS.find(item => !Object.hasOwn(variables.value, item)) || ''; variableText.value = variables.value[key] || ''; variableOpen.value = true }
function applyVariable() { if (!variableKey.value) return; const next = { ...variables.value }; if (oldVariableKey.value && oldVariableKey.value !== variableKey.value) delete next[oldVariableKey.value]; next[variableKey.value] = variableText.value; variables.value = next; touch(); variableOpen.value = false }
function removeVariable(key: string) { const next = { ...variables.value }; delete next[key]; variables.value = next; touch() }
const rawOpen = ref(false), rawDraft = ref(''), rawError = ref('')
function editRaw() { rawDraft.value = JSON.stringify(source.value, null, 2); rawError.value = ''; rawOpen.value = true }
function applyRaw() { try { source.value = parsePresetObject(rawDraft.value); touch(); rawOpen.value = false } catch (error) { rawError.value = error instanceof Error ? error.message : 'JSON 格式不正确。' } }
const metadataOpen = ref(false), nameDraft = ref(''), descriptionDraft = ref('')
function editMetadata() { nameDraft.value = name.value; descriptionDraft.value = description.value; metadataOpen.value = true }
function applyMetadata() { if (!nameDraft.value.trim()) return; name.value = nameDraft.value.trim(); description.value = descriptionDraft.value; touch(); metadataOpen.value = false }
function payload() { return { name: name.value, description: description.value, sourceJson: source.value, variables: variables.value } }
const compatibility = computed(() => checked.value || data.value?.compatibility)
async function validate() { const result = await run(() => api<{ compatibility: PresetView['compatibility'] }>('/api/presets/validate', { method: 'POST', body: payload() })); if (result.ok) checked.value = result.value.compatibility }
async function save() {
  const result = await run(() => api<PresetView>('/api/presets/' + encodeURIComponent(id), { method: 'PATCH', body: payload() }), '预设已保存')
  if (result.ok) { data.value = result.value; load(result.value); await refreshNuxtData(['nexus-preset-summaries', 'nexus-preset-list']) }
  return result.ok
}
async function download() {
  await run(async () => {
    const body = await api<Record<string, unknown>>('/api/presets/' + encodeURIComponent(id) + '/export'), url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = name.value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
}
const deleteOpen = ref(false), allowLeave = ref(false)
async function remove() { const result = await run(() => api('/api/presets/' + encodeURIComponent(id), { method: 'DELETE' }), '预设已删除'); if (result.ok) { allowLeave.value = true; deleteOpen.value = false; await refreshNuxtData('nexus-preset-summaries'); await navigateTo('/presets') } }
const leaveOpen = ref(false)
let resolveLeave: ((leave: boolean) => void) | undefined
function finishLeave(leave: boolean) { resolveLeave?.(leave); resolveLeave = undefined; leaveOpen.value = false }
watch(leaveOpen, open => { if (!open) finishLeave(false) })
onBeforeRouteLeave(() => { if (allowLeave.value || !dirty.value) return true; leaveOpen.value = true; return new Promise<boolean>(resolve => { resolveLeave = resolve }) })
async function saveAndLeave() { if (await save()) finishLeave(true) }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); finishLeave(false) })
</script>

<template>
  <div class="preset-detail">
    <NuxtLink to="/presets" class="preset-back"><UIcon name="i-ph-arrow-left-bold" />返回预设库</NuxtLink>
    <AppState v-if="error && !data" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" />
    <template v-else>
      <AppPageHeader :title="name" :description="description || '按名称查找条目，使用开关启停，点击笔图标编辑。'"><button class="icon-button" aria-label="编辑预设名称和说明" :disabled="busy" @click="editMetadata"><UIcon name="i-ph-pencil-simple-bold" /></button><button class="button" :disabled="busy" @click="download"><UIcon name="i-ph-download-simple-bold" />导出</button><button class="button" :disabled="busy" @click="editRaw">原始 JSON</button><button class="icon-button danger" aria-label="删除预设" :disabled="busy" @click="deleteOpen = true"><UIcon name="i-ph-trash-bold" /></button></AppPageHeader>
      <div class="nexus-tabs detail-tabs" role="tablist" aria-label="预设内容"><button role="tab" :aria-selected="tab === 'prompts'" @click="tab = 'prompts'">提示词条目 <span>{{ rows.length }}</span></button><button role="tab" :aria-selected="tab === 'sampling'" @click="tab = 'sampling'">采样参数</button><button role="tab" :aria-selected="tab === 'variables'" @click="tab = 'variables'">上下文变量 <span>{{ Object.keys(variables).length }}</span></button></div>
      <section class="panel entries-panel">
        <template v-if="tab === 'prompts'">
          <div class="entry-tools"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索条目名称" placeholder="搜索条目名称或标识"></label><select v-model="filter" aria-label="筛选条目状态"><option value="all">全部条目</option><option value="enabled">已开启</option><option value="disabled">已关闭</option></select><span class="muted small-text">{{ enabledCount }} / {{ rows.length }} 已开启</span></div>
          <div v-if="visible.length" class="entry-list"><article v-for="row in visible" :key="row.index + ':' + row.identifier" class="entry-row" :class="{ inactive: !row.enabled }"><span class="entry-name">{{ row.name }}</span><div class="entry-actions"><label class="entry-switch"><input type="checkbox" role="switch" :checked="row.enabled" :aria-label="'开启 ' + row.name" :disabled="busy" @change="toggle(row, $event)"><span aria-hidden="true" /></label><button class="icon-button" :aria-label="'编辑 ' + row.name" :disabled="busy" @click="editPrompt(row)"><UIcon name="i-ph-pencil-simple-bold" /></button><details class="entry-menu"><summary :aria-label="'调整 ' + row.name + ' 的顺序'"><UIcon name="i-ph-dots-three-vertical-bold" /></summary><div><button :disabled="busy || rows[0]?.identifier === row.identifier" @click="move(row, -1)"><UIcon name="i-ph-arrow-up-bold" />上移一项</button><button :disabled="busy || rows[rows.length - 1]?.identifier === row.identifier" @click="move(row, 1)"><UIcon name="i-ph-arrow-down-bold" />下移一项</button></div></details></div></article></div>
          <AppState v-else compact :title="ambiguousOrder ? '提示词顺序尚未确定' : rows.length ? '没有匹配的条目' : '此预设没有 prompts 条目'" :description="ambiguousOrder ? '请在原始 JSON 中提供明确的全局 100000 顺序。' : rows.length ? '调整搜索或筛选条件。' : '旧格式字段可以通过原始 JSON 编辑。'" />
        </template>
        <template v-else-if="tab === 'sampling'"><p class="section-description">开启参数后点击笔图标设置数值；关闭表示不指定该参数。客户端明确提供的参数优先。</p><article v-for="field in presetSamplingFields" :key="field.key" class="entry-row"><span class="entry-name">{{ field.name }}<small>{{ settings[presetSamplingKey(source, field)] ?? '未指定' }}</small></span><div class="entry-actions"><label class="entry-switch"><input type="checkbox" role="switch" :checked="settings[presetSamplingKey(source, field)] !== undefined" :aria-label="'指定 ' + field.name" :disabled="busy" @change="toggleSampling(field, $event)"><span aria-hidden="true" /></label><button class="icon-button" :aria-label="'编辑 ' + field.name" :disabled="busy" @click="editSampling(field)"><UIcon name="i-ph-pencil-simple-bold" /></button></div></article></template>
        <template v-else><div class="entry-tools"><p class="muted small-text">变量按预设保存，可在条目内容中使用对应宏。</p><button class="button small" :disabled="busy" @click="editVariable()"><UIcon name="i-ph-plus-bold" />添加变量</button></div><article v-for="(_, key) in variables" :key="key" class="entry-row"><span class="entry-name mono">{{ key }}</span><div class="entry-actions"><button class="icon-button" :aria-label="'编辑变量 ' + key" :disabled="busy" @click="editVariable(String(key))"><UIcon name="i-ph-pencil-simple-bold" /></button><button class="icon-button danger" :aria-label="'删除变量 ' + key" :disabled="busy" @click="removeVariable(String(key))"><UIcon name="i-ph-trash-bold" /></button></div></article><AppState v-if="!Object.keys(variables).length" compact title="还没有上下文变量" description="按需添加 user、char、scenario 等实际内容。" /></template>
      </section>
      <details v-if="compatibility" class="compatibility-note"><summary><UIcon :name="!dirty && compatibility.supported ? 'i-ph-check-circle-bold' : 'i-ph-info-bold'" />{{ dirty && !checked ? '内容已修改，可检查兼容性后保存' : compatibility.supported ? '兼容检查通过' : '需要处理兼容问题' }}<span v-if="compatibility.issues.length">{{ compatibility.issues.length }} 条说明</span></summary><ul><li v-for="(issue, index) in compatibility.issues" :key="index" :class="issue.severity">{{ issue.message }}<code v-if="issue.path">{{ issue.path }}</code></li></ul></details>
      <div class="detail-save-bar"><span :class="dirty ? 'pending-label' : 'muted'">{{ dirty ? '有未保存修改' : '已保存' }}</span><div class="inline-actions"><button class="button" :disabled="busy" @click="validate">检查兼容性</button><button class="button" :disabled="busy || !dirty" @click="data && load(data)">还原</button><button class="button primary" :disabled="busy || !dirty" @click="save"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />保存预设</button></div></div>
    </template>
    <AppDialog v-model="promptOpen" :title="'编辑条目 · ' + (editing?.name || '')" wide><form id="edit-prompt-form" class="form-stack" @submit.prevent="applyPrompt"><template v-if="editing && editing.index >= 0"><div class="form-row"><label class="field"><span>条目名称</span><input v-model="promptName" required></label><label class="field"><span>消息角色</span><select v-model="promptRole"><option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option></select></label></div><template v-if="!editing.marker"><label class="field"><span>条目内容</span><textarea ref="contentInput" v-model="promptContent" rows="14" spellcheck="false" class="nexus-code-editor" /></label><div class="macro-buttons"><span class="muted small-text">插入变量</span><button v-for="key in ['user', 'char', 'scenario', 'description', 'persona']" :key="key" type="button" class="button small mono" @click="insertMacro(key)">{{ '\{\{' + key + '\}\}' }}</button><button type="button" class="text-link" @click="promptOpen = false; tab = 'variables'">管理变量</button></div></template><p v-else class="muted small-text">此项为上下文标记，内容来自实际聊天或本预设的上下文变量。</p><details class="advanced-prompt"><summary>注入设置与生成触发器</summary><div class="form-stack"><label class="field"><span>注入位置</span><select v-model="promptPosition"><option value="0">按列表顺序</option><option value="1">插入聊天历史</option></select></label><div class="form-row"><label class="field"><span>距历史末尾的深度</span><input v-model="promptDepth" type="number" min="0" step="1"></label><label class="field"><span>注入优先级</span><input v-model="promptOrder" type="number" step="1"></label></div><span class="small-text muted">生成触发器（不选表示全部）</span><div class="trigger-list"><label v-for="trigger in generationTypes" :key="trigger"><input v-model="promptTriggers" type="checkbox" :value="trigger">{{ trigger }}</label></div></div></details></template><p v-else class="muted">聊天历史由客户端请求提供，可以在列表中控制是否开启。</p><p v-if="validation" class="inline-error" role="alert">{{ validation }}</p></form><template #footer><button class="button" @click="promptOpen = false">取消</button><button class="button primary" form="edit-prompt-form">{{ editing?.index === -1 ? '完成' : '应用修改' }}</button></template></AppDialog>
    <AppDialog v-model="samplingOpen" :title="'编辑参数 · ' + (sampleField?.name || '')"><form id="edit-sampling-form" class="form-stack" @submit.prevent="applySampling"><label class="field"><span>参数值</span><input v-model="sampleValue" type="number" :min="sampleField?.min" :max="sampleField?.max" :step="sampleField?.step" placeholder="留空表示不指定"><small>{{ sampleField?.key }}</small></label><p v-if="sampleError" class="inline-error" role="alert">{{ sampleError }}</p></form><template #footer><button class="button" @click="samplingOpen = false">取消</button><button form="edit-sampling-form" class="button primary">应用修改</button></template></AppDialog>
    <AppDialog v-model="variableOpen" title="编辑上下文变量" wide><form id="edit-variable-form" class="form-stack" @submit.prevent="applyVariable"><label class="field"><span>变量名称</span><select v-model="variableKey" required><option v-for="key in PRESET_CONTEXT_KEYS" :key="key" :value="key" :disabled="key !== oldVariableKey && Object.hasOwn(variables, key)">{{ key }}</option></select></label><label class="field"><span>变量内容</span><textarea v-model="variableText" rows="12" spellcheck="false" /></label></form><template #footer><button class="button" @click="variableOpen = false">取消</button><button form="edit-variable-form" class="button primary" :disabled="!variableKey">应用修改</button></template></AppDialog>
    <AppDialog v-model="rawOpen" title="原始预设 JSON" description="保留完整导入字段，应用后再保存预设。" wide><form id="edit-raw-form" class="form-stack" @submit.prevent="applyRaw"><label class="field"><span class="sr-only">原始 JSON</span><textarea v-model="rawDraft" class="nexus-code-editor" rows="22" spellcheck="false" /></label><p v-if="rawError" class="inline-error" role="alert">{{ rawError }}</p></form><template #footer><button class="button" @click="rawOpen = false">取消</button><button form="edit-raw-form" class="button primary">应用 JSON</button></template></AppDialog>
    <AppDialog v-model="metadataOpen" title="预设名称与说明"><form id="edit-metadata-form" class="form-stack" @submit.prevent="applyMetadata"><label class="field"><span>名称</span><input v-model="nameDraft" required></label><label class="field"><span>说明</span><textarea v-model="descriptionDraft" rows="3" /></label></form><template #footer><button class="button" @click="metadataOpen = false">取消</button><button form="edit-metadata-form" class="button primary" :disabled="!nameDraft.trim()">应用修改</button></template></AppDialog>
    <AppDialog v-model="deleteOpen" title="删除预设" :description="name" :close-disabled="busy"><p class="muted">删除后，这个预设将从后续调用的叠加列表中移除。已被旧路由单独引用的预设需要先解除绑定。</p><template #footer><button class="button" :disabled="busy" @click="deleteOpen = false">取消</button><button class="button danger-solid" :disabled="busy" @click="remove">删除预设</button></template></AppDialog>
    <AppDialog v-model="leaveOpen" title="预设有未保存修改" description="保存后离开，或放弃本次修改。" :close-disabled="busy"><template #footer><button class="button" :disabled="busy" @click="finishLeave(false)">继续编辑</button><button class="button" :disabled="busy" @click="finishLeave(true)">放弃修改</button><button class="button primary" :disabled="busy" @click="saveAndLeave">保存并离开</button></template></AppDialog>
  </div>
</template>

<style scoped>
.preset-back { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); margin-bottom: 20px; font-size: 13px; }.preset-back:hover { color: var(--ink); }.detail-tabs { margin-bottom: 20px; }.detail-tabs span { font-size: 11px; margin-left: 4px; color: var(--muted); }.entries-panel { padding: 0; }.entry-tools { display: flex; align-items: center; gap: 16px; padding: 20px; border-bottom: 1px solid var(--border); }.entry-tools .search-field { flex: 1; min-width: 0; max-width: 520px; }.entry-tools input { width: 100%; min-width: 0; }.entry-tools select { padding: 9px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); font-size: 13px; }.entry-tools > .button { margin-left: auto; }.entry-row { display: flex; align-items: center; gap: 16px; justify-content: space-between; min-height: 64px; padding: 14px 20px; border-bottom: 1px solid var(--border); }.entry-row:last-child { border-bottom: 0; }.entry-name { font-size: 14px; overflow-wrap: anywhere; min-width: 0; }.entry-name small { display: block; font-size: 12px; color: var(--muted); margin-top: 4px; }.entry-row.inactive .entry-name { color: var(--muted); }.entry-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }.entry-switch { position: relative; display: inline-flex; align-items: center; padding: 6px 0; cursor: pointer; }.entry-switch input { position: absolute; opacity: 0; width: 36px; height: 28px; margin: 0; }.entry-switch > span { width: 32px; height: 19px; border-radius: 20px; background: #ccd0ca; transition: background .15s; }.entry-switch > span::after { content: ''; display: block; width: 13px; height: 13px; margin: 3px; background: white; border-radius: 50%; transition: transform .15s; }.entry-switch input:checked + span { background: var(--green); }.entry-switch input:checked + span::after { transform: translateX(13px); }.entry-switch input:focus-visible + span { outline: 2px solid var(--green); outline-offset: 3px; }.entry-switch input:disabled + span { opacity: .5; }.entry-menu { position: relative; }.entry-menu summary { list-style: none; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; cursor: pointer; color: var(--muted); }.entry-menu summary::-webkit-details-marker { display: none; }.entry-menu > div { position: absolute; right: 0; top: 32px; z-index: 3; min-width: 130px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); box-shadow: 0 4px 16px #0000000c; }.entry-menu button { display: flex; gap: 8px; width: 100%; padding: 8px; white-space: nowrap; font-size: 12px; }.entry-menu button:hover { background: var(--green-bg); }.entry-menu button:disabled { opacity: .4; }.section-description { color: var(--muted); font-size: 13px; padding: 20px; border-bottom: 1px solid var(--border); }.compatibility-note { margin: 20px 0; color: var(--muted); font-size: 12px; }.compatibility-note summary { display: flex; align-items: center; gap: 8px; cursor: pointer; }.compatibility-note summary span { margin-left: auto; }.compatibility-note ul { padding: 12px 24px; line-height: 1.9; }.compatibility-note code { display: block; overflow-wrap: anywhere; }.compatibility-note .error { color: var(--red); }.detail-save-bar { position: sticky; bottom: 16px; z-index: 5; display: flex; justify-content: space-between; align-items: center; gap: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; margin-top: 20px; font-size: 12px; }.pending-label { color: var(--amber); }.macro-buttons { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }.advanced-prompt summary { cursor: pointer; color: var(--muted); font-size: 12px; }.advanced-prompt > div { margin-top: 16px; }.trigger-list { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; }.trigger-list label { display: flex; gap: 6px; align-items: center; }
@media(max-width:600px) { .entry-tools { flex-wrap: wrap; padding: 16px; gap: 12px; }.entry-tools .search-field { flex-basis: 100%; max-width: none; }.entry-row { padding: 12px 16px; gap: 10px; }.entry-actions { gap: 4px; }.detail-save-bar { flex-wrap: wrap; bottom: 8px; padding: 12px; }.detail-save-bar .inline-actions { flex-wrap: wrap; }.detail-save-bar .button { font-size: 12px; padding: 8px 10px; } }
</style>
