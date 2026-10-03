<script setup lang="ts">
import type { PresetView, KeyPresetBinding } from '#shared/presets'
import { PRESET_MAX_BYTES } from '#shared/presets'
interface ModelKey { id: string; name: string; prefix: string; enabled: boolean; moduleId: 'commandcode' | 'cpa' }

useHead({ title: '请求预设 · CPA Nexus' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<{ presets: PresetView[]; moduleEnabled: boolean }>('/api/presets', { key: 'nexus-preset-list' })
const { data: routes, error: routesError, refresh: refreshRoutes } = await useFetch<{ bindings: KeyPresetBinding[] }>('/api/presets/routes', { key: 'nexus-preset-routes' })
const keyBindings = computed(() => routes.value?.bindings || [])
const { data: keys, pending: keysPending, error: keysError, refresh: refreshKeys } = await useFetch<{ items: ModelKey[] }>('/api/keys', { key: 'nexus-model-keys' })
const modelKeys = computed(() => keys.value?.items || [])
const selectedKeyId = ref('')
watch(modelKeys, items => { if (!items.some(item => item.id === selectedKeyId.value)) selectedKeyId.value = items[0]?.id || '' }, { immediate: true })
const selectedKey = computed(() => modelKeys.value.find(item => item.id === selectedKeyId.value))
const { busy, run } = useApiAction()
const search = ref('')
const visible = computed(() => (data.value?.presets || []).filter(item => [item.name, item.description].some(value => value.toLowerCase().includes(search.value.toLowerCase()))))
const selected = ref<PresetView | null>(null)
const name = ref('')
const description = ref('')
const sourceJson = ref<Record<string, unknown>>({})
const jsonDraft = ref('{}')
const variablesDraft = ref('{}')
const baseline = ref('')
const editorTab = ref<'prompts' | 'sampling' | 'variables' | 'raw'>('prompts')
const validation = ref('')
const checked = ref<PresetView['compatibility'] | null>(null)
const ambiguousOrder = computed(() => presetPromptOrderAmbiguous(sourceJson.value))
const promptRows = computed(() => ambiguousOrder.value ? [] : presetPromptRows(sourceJson.value))
const samplingSettings = computed(() => presetDocumentSettings(sourceJson.value))
const serialized = computed(() => JSON.stringify({ name: name.value, description: description.value, sourceJson: sourceJson.value, variablesDraft: variablesDraft.value }))
const dirty = computed(() => !!selected.value && (serialized.value !== baseline.value || jsonDraft.value !== JSON.stringify(sourceJson.value, null, 2)))
const importOpen = ref(false)
const importName = ref('')
const importText = ref('')
const importError = ref('')
const importingFile = ref(false)
const deleteTarget = ref<PresetView | null>(null)
const deleteOpen = computed({ get: () => !!deleteTarget.value, set: value => { if (!value) deleteTarget.value = null } })
const switchTarget = ref<PresetView | null>(null)
const switchOpen = computed({ get: () => !!switchTarget.value, set: value => { if (!value) switchTarget.value = null } })
const compatibility = computed(() => checked.value || selected.value?.compatibility)
const unvalidated = computed(() => dirty.value && !checked.value)

watch(sourceJson, value => { jsonDraft.value = JSON.stringify(value, null, 2); checked.value = null }, { deep: true })
watch(variablesDraft, () => { checked.value = null })

function loadPreset(preset: PresetView) {
  selected.value = preset
  name.value = preset.name
  description.value = preset.description
  sourceJson.value = structuredClone(toRaw(preset.sourceJson))
  jsonDraft.value = JSON.stringify(sourceJson.value, null, 2)
  variablesDraft.value = JSON.stringify(preset.variables, null, 2)
  baseline.value = serialized.value
  checked.value = null
  validation.value = ''
}
function selectPreset(preset: PresetView) {
  if (selected.value?.id === preset.id) return
  if (dirty.value) switchTarget.value = preset
  else loadPreset(preset)
}
function discardAndSwitch() {
  if (switchTarget.value) loadPreset(switchTarget.value)
  switchTarget.value = null
}
function inputValue(event: Event) { return (event.target as HTMLInputElement).value }
function updatePrompt(row: PresetPromptRow, field: 'name' | 'role' | 'content', event: Event) { updatePresetPrompt(sourceJson.value, row, field, inputValue(event)) }
function togglePrompt(row: PresetPromptRow, event: Event) { updatePresetPrompt(sourceJson.value, row, 'enabled', (event.target as HTMLInputElement).checked) }
function setSampling(field: typeof presetSamplingFields[number], event: Event) {
  const value = inputValue(event)
  const key = presetSamplingKey(sourceJson.value, field)
  if (!value.trim()) for (const alias of [field.key, ...field.aliases]) delete samplingSettings.value[alias]
  else samplingSettings.value[key] = Number(value)
}
function applyRaw() {
  validation.value = ''
  try { sourceJson.value = parsePresetObject(jsonDraft.value) }
  catch (error) { validation.value = error instanceof Error ? error.message : 'JSON 格式不正确。' }
}
function payload() {
  return { name: name.value.trim(), description: description.value, sourceJson: parsePresetObject(jsonDraft.value), variables: parsePresetVariables(variablesDraft.value) }
}
async function validate() {
  validation.value = ''
  try {
    const body = payload()
    const result = await run(() => api<{ sourceJson: Record<string, unknown>; compatibility: PresetView['compatibility'] }>('/api/presets/validate', { method: 'POST', body }))
    if (result.ok) { sourceJson.value = result.value.sourceJson; await nextTick(); checked.value = result.value.compatibility }
  } catch (error) { validation.value = error instanceof Error ? error.message : '请检查预设内容。' }
}
async function save() {
  if (!selected.value) return
  validation.value = ''
  try {
    const body = payload()
    const result = await run(() => api<PresetView>('/api/presets/' + encodeURIComponent(selected.value!.id), { method: 'PATCH', body }), '预设已保存')
    if (result.ok) { loadPreset(result.value); await refresh() }
  } catch (error) { validation.value = error instanceof Error ? error.message : '请检查预设内容。' }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importError.value = ''
  if (file.size > PRESET_MAX_BYTES) { importError.value = '文件不能超过 1 MB。'; input.value = ''; return }
  importingFile.value = true
  try { importText.value = await file.text(); if (!importName.value) importName.value = file.name.replace(/\.json$/i, '') }
  catch { importError.value = '文件读取失败，请重新选择。' }
  finally { importingFile.value = false; input.value = '' }
}
async function importPreset() {
  importError.value = ''
  try {
    const source = parsePresetObject(importText.value)
    const result = await run(() => api<PresetView>('/api/presets', { method: 'POST', body: { name: importName.value.trim(), sourceJson: source } }), '预设已导入')
    if (result.ok) { importOpen.value = false; importName.value = ''; importText.value = ''; await refresh(); selectPreset(result.value) }
  } catch (error) { importError.value = error instanceof Error ? error.message : 'JSON 格式不正确。' }
}
async function remove() {
  if (!deleteTarget.value) return
  const id = deleteTarget.value.id
  const result = await run(() => api('/api/presets/' + encodeURIComponent(id), { method: 'DELETE' }), '预设已删除')
  if (result.ok) { deleteTarget.value = null; if (selected.value?.id === id) selected.value = null; await refresh(); await refreshNuxtData('nexus-preset-routes') }
}
async function toggleModule() {
  const result = await run(() => api('/api/modules', { method: 'PATCH', body: { id: 'presets', enabled: !data.value?.moduleEnabled } }), data.value?.moduleEnabled ? '预设模块已停用' : '预设模块已启用')
  if (result.ok) { await refresh(); await refreshNuxtData('nexus-modules') }
}
async function resetRoute(binding: KeyPresetBinding) {
  const result = await run(() => api('/api/presets/routes', { method: 'PUT', body: { keyId: binding.keyId, mode: 'inherit', presetId: null } }), 'API key 已恢复默认直连')
  if (result.ok) await refreshRoutes()
}
function presetName(id: string | null) { return data.value?.presets.find(item => item.id === id)?.name || '预设已不存在' }
function bindingKeyName(binding: KeyPresetBinding) { return modelKeys.value.find(item => item.id === binding.keyId)?.name || binding.keyId }
async function download() {
  if (!selected.value) return
  const preset = selected.value
  await run(async () => {
    const body = await api<Record<string, unknown>>('/api/presets/' + encodeURIComponent(preset.id) + '/export')
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = preset.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
}
</script>

<template>
  <div class="presets-page">
    <AppPageHeader title="请求预设" description="导入 SillyTavern JSON，编辑提示词与参数，再选择需要使用它的模型 API key。">
      <button class="button" :disabled="pending || busy" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" />重新读取</button>
      <button class="button primary" :disabled="busy" @click="importOpen = true"><UIcon name="i-ph-upload-simple-bold" />导入预设</button>
    </AppPageHeader>
    <AppState v-if="error && !data" :error="error" @retry="refresh()" />
    <AppState v-else-if="!data" :loading="pending" />
    <template v-else>
      <section class="preset-module-bar"><div><span class="status-badge" :class="data.moduleEnabled ? 'green' : 'neutral'"><span class="status-dot" />{{ data.moduleEnabled ? '模块已启用' : '模块已停用' }}</span><p>{{ data.moduleEnabled ? '只对已选择预设的路由生效。' : '所有请求保持直连；可以继续导入和编辑预设。' }}</p></div><button class="button" :disabled="busy" @click="toggleModule">{{ data.moduleEnabled ? '停用预设模块' : '启用预设模块' }}</button></section>
      <div class="notice preset-notice"><UIcon name="i-ph-info-bold" /><p>这里管理请求预设。角色卡、世界书和聊天上下文需要你提供；没有提供的变量不会自动补齐。不支持的扩展会列出原因，不能绑定到请求路由。</p></div>
      <div class="preset-workspace">
        <aside class="preset-library panel" aria-label="已保存的预设"><div class="panel-heading"><h2>预设库</h2><span class="muted small-text">{{ data.presets.length }} 个</span></div><label class="search-field preset-search"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" placeholder="搜索预设" aria-label="搜索预设"></label><div v-if="visible.length" class="preset-list"><button v-for="preset in visible" :key="preset.id" class="preset-list-item" :class="{ active: selected?.id === preset.id }" :aria-pressed="selected?.id === preset.id" @click="selectPreset(preset)"><strong>{{ preset.name }}</strong><span>{{ preset.description || 'SillyTavern JSON 预设' }}</span><small :class="preset.compatibility.supported ? 'preset-compatible' : 'preset-incompatible'">{{ preset.compatibility.supported ? '兼容检查通过' : '需要处理兼容问题' }}</small></button></div><AppState v-else compact :title="search ? '没有匹配预设' : '还没有预设'" description="导入一个 JSON 文件，或粘贴预设内容开始编辑。" /></aside>
        <section v-if="selected" class="preset-editor panel" aria-label="预设编辑器"><div class="preset-editor-heading"><div><span class="eyebrow">预设编辑</span><h2>{{ selected.name }}</h2><p>最近保存 {{ formatDate(selected.updatedAt) }}</p></div><div class="inline-actions"><button class="button small" :disabled="busy" @click="download"><UIcon name="i-ph-download-simple-bold" />导出</button><button class="button small danger" :disabled="busy" @click="deleteTarget = selected">删除</button></div></div>
          <fieldset class="form-stack" :disabled="busy"><div class="form-row"><label class="field"><span>名称</span><input v-model="name" maxlength="120" required></label><label class="field"><span>说明</span><input v-model="description" maxlength="2000" placeholder="记录这个预设的用途"></label></div>
            <div class="nexus-tabs preset-editor-tabs" role="tablist" aria-label="预设编辑内容"><button role="tab" :aria-selected="editorTab === 'prompts'" @click="editorTab = 'prompts'">提示词</button><button role="tab" :aria-selected="editorTab === 'sampling'" @click="editorTab = 'sampling'">采样参数</button><button role="tab" :aria-selected="editorTab === 'variables'" @click="editorTab = 'variables'">上下文变量</button><button role="tab" :aria-selected="editorTab === 'raw'" @click="editorTab = 'raw'">原始 JSON</button></div>
            <div v-if="editorTab === 'prompts'" class="preset-prompts"><p class="preset-section-intro">按顺序应用已启用的提示词。顺序、角色和原始注入设置保存在预设 JSON 中。</p><article v-for="(prompt, index) in promptRows" :key="prompt.identifier" class="preset-prompt"><div class="preset-prompt-toolbar"><label class="preset-prompt-toggle"><input type="checkbox" :checked="prompt.enabled" @change="togglePrompt(prompt, $event)"><span>{{ prompt.name }}</span></label><div class="inline-actions"><span v-if="prompt.marker" class="status-badge neutral">上下文标记</span><button class="icon-button" :disabled="index === 0" :aria-label="`上移 ${prompt.name}`" @click="movePresetPrompt(sourceJson, prompt.identifier, -1)"><UIcon name="i-ph-arrow-up-bold" /></button><button class="icon-button" :disabled="index === promptRows.length - 1" :aria-label="`下移 ${prompt.name}`" @click="movePresetPrompt(sourceJson, prompt.identifier, 1)"><UIcon name="i-ph-arrow-down-bold" /></button></div></div><div class="form-row"><label class="field"><span>提示词名称</span><input :value="prompt.name" :disabled="prompt.index < 0" maxlength="200" @input="updatePrompt(prompt, 'name', $event)"></label><label class="field"><span>消息角色</span><select :value="prompt.role" :disabled="prompt.index < 0" @change="updatePrompt(prompt, 'role', $event)"><option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option></select></label></div><label v-if="!prompt.marker" class="field"><span class="sr-only">{{ prompt.name }} 内容</span><textarea :value="prompt.content" rows="5" spellcheck="false" @input="updatePrompt(prompt, 'content', $event)" /></label><p v-else class="small-text muted">此项由实际聊天消息或你提供的上下文变量填充，兼容检查会确认支持情况。</p></article><AppState v-if="!promptRows.length" compact :title="ambiguousOrder ? '提示词顺序尚未确定' : '此文件没有 prompts 列表'" :description="ambiguousOrder ? '文件含多个角色顺序，但没有全局 100000 顺序。请在原始 JSON 中提供明确的全局顺序后检查。' : '可以在原始 JSON 中编辑旧格式的提示词字段，再执行兼容检查。'" /></div>
            <div v-else-if="editorTab === 'sampling'" class="preset-sampling"><p class="preset-section-intro">留空表示不在预设中指定。不同上游支持的参数可能不同，兼容检查会列出无法应用的参数。</p><div class="preset-sampling-grid"><label v-for="field in presetSamplingFields" :key="field.key" class="field"><span>{{ field.name }}</span><input :value="samplingSettings[presetSamplingKey(sourceJson, field)] ?? ''" type="number" :min="field.min" :max="field.max" :step="field.step" placeholder="不指定" @input="setSampling(field, $event)"><small class="mono">{{ field.key }}</small></label></div></div>
            <div v-else-if="editorTab === 'variables'" class="form-stack"><p class="preset-section-intro">为预设中实际使用的宏提供文本。例如 user、char、description、personality、scenario、persona、mesExamples、wiBefore、wiAfter。值必须是字符串，未提供的必需变量会阻止绑定。</p><label class="field"><span>上下文变量 JSON</span><textarea v-model="variablesDraft" class="nexus-code-editor" rows="12" spellcheck="false" /></label></div>
            <div v-else class="form-stack"><p class="preset-section-intro">完整保留导入的字段。高级内容修改后点击“应用 JSON”，或者直接检查、保存；导出的是已保存的原始预设。</p><label class="field"><span>原始预设 JSON</span><textarea v-model="jsonDraft" class="nexus-code-editor" rows="20" spellcheck="false" /></label><div class="inline-actions"><button class="button small" @click="applyRaw">应用 JSON 到编辑器</button></div></div>
          </fieldset>
          <div v-if="compatibility" class="preset-compatibility" :class="{ supported: compatibility.supported && !unvalidated }" role="status"><strong>{{ unvalidated ? '内容已修改，请重新检查' : compatibility.supported ? '兼容检查通过' : '此预设暂不能用于请求' }}</strong><ul v-if="compatibility.issues.length"><li v-for="(issue, index) in compatibility.issues" :key="index" :class="issue.severity"><span>{{ issue.severity === 'error' ? '需要处理' : '提示' }}</span>{{ issue.message }}<code v-if="issue.path">{{ issue.path }}</code></li></ul><p v-else>保存后可以在下方为 API key 选择使用。</p></div>
          <p v-if="validation" class="inline-error" role="alert">{{ validation }}</p><div class="nexus-editor-footer"><span class="muted small-text">{{ dirty ? '有未保存修改' : '当前预设已保存' }}</span><div class="inline-actions"><button class="button" :disabled="busy" @click="validate">检查兼容性</button><button class="button" :disabled="busy || !dirty" @click="loadPreset(selected)">还原修改</button><button class="button primary" :disabled="busy || !dirty || !name.trim()" @click="save"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />保存预设</button></div></div>
        </section>
        <section v-else class="panel preset-empty-editor"><UIcon name="i-ph-sliders-horizontal-bold" /><h2>选择预设开始编辑</h2><p>从左侧打开已保存的预设，或导入 SillyTavern 导出的 JSON。预设只有被绑定到路由后才会影响请求。</p><button class="button primary" @click="importOpen = true">导入第一个预设</button></section>
      </div>
      <section class="panel section-gap preset-key-routes"><div class="panel-heading"><h2>按 API key 使用预设</h2><div class="inline-actions"><NuxtLink to="/keys" class="text-link">管理 API key</NuxtLink><button class="button small" :disabled="keysPending || busy" @click="refreshKeys()">刷新</button></div></div><p class="nexus-description">选择平台创建的模型 API key。只有选用预设的 key 会处理提示词，其他 key 默认直连。例如 KA 保持直连，KB 使用酒馆预设；账号池中的账号由模型模块自动选择。</p><AppState v-if="keysError" :error="keysError" compact @retry="refreshKeys()" /><AppState v-else-if="keysPending && !keys" compact loading /><AppState v-else-if="!modelKeys.length" compact title="还没有模型 API key" description="先在 API key 页面创建模型调用 key，并绑定 CommandCode 或 CPA。" /><template v-else><label class="field preset-key-select"><span>选择 API key</span><select v-model="selectedKeyId"><option v-for="key in modelKeys" :key="key.id" :value="key.id">{{ key.name }} · {{ key.moduleId === 'cpa' ? 'CPA' : 'CommandCode' }}{{ key.enabled ? '' : ' · 已停用' }}</option></select><small v-if="selectedKey">{{ selectedKey.prefix }}… · 绑定 {{ selectedKey.moduleId === 'cpa' ? 'CPA' : 'CommandCode' }}</small></label><PresetRoutePicker v-if="selectedKeyId" :key="selectedKeyId" :key-id="selectedKeyId" @saved="refreshRoutes()" /></template></section>

      <section class="table-panel section-gap"><div class="panel-heading padded"><h2>API key 预设绑定</h2><span class="muted small-text">{{ keyBindings.length }} 个 key</span></div><AppState v-if="routesError" :error="routesError" compact @retry="refreshRoutes()" /><AppState v-else-if="!keyBindings.length" compact title="所有模型 API key 默认直连" description="在上方选择一个 key，为它绑定酒馆预设。" /><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>API key</th><th>绑定模块</th><th>处理方式</th><th>最近保存</th><th>操作</th></tr></thead><tbody><tr v-for="binding in keyBindings" :key="binding.keyId"><td>{{ bindingKeyName(binding) }}</td><td>{{ binding.moduleId === 'cpa' ? 'CPA' : 'CommandCode' }}</td><td>{{ binding.mode === 'bypass' ? '直连' : presetName(binding.presetId) }}</td><td>{{ formatDate(binding.updatedAt) }}</td><td><button class="button small" :disabled="busy" @click="resetRoute(binding)">恢复默认直连</button></td></tr></tbody></table></div></section>
    </template>
    <AppDialog v-model="importOpen" title="导入 SillyTavern 预设" description="选择 JSON 文件，或直接粘贴完整预设。" wide :close-disabled="busy || importingFile"><form id="preset-import-form" class="form-stack" @submit.prevent="importPreset"><label class="field"><span>预设名称</span><input v-model="importName" maxlength="120" required placeholder="例如：日常对话"></label><label class="button preset-file-input"><UIcon name="i-ph-file-arrow-up-bold" />{{ importingFile ? '正在读取文件' : '选择 JSON 文件' }}<input class="sr-only" type="file" accept=".json,application/json" :disabled="busy || importingFile" @change="upload"></label><label class="field"><span>预设 JSON</span><textarea v-model="importText" class="nexus-code-editor" rows="15" required spellcheck="false" placeholder="粘贴 SillyTavern 导出的 JSON 对象" /></label><p class="small-text muted">导入会保存原始内容并检查兼容性。尚不兼容的文件仍可保存、编辑和导出。</p><p v-if="importError" class="inline-error" role="alert">{{ importError }}</p></form><template #footer><button class="button" :disabled="busy || importingFile" @click="importOpen = false">取消</button><button form="preset-import-form" class="button primary" :disabled="busy || importingFile || !importName.trim() || !importText.trim()">导入并检查</button></template></AppDialog>
    <AppDialog v-model="deleteOpen" title="删除预设" :description="`删除 ${deleteTarget?.name || ''}。`" :close-disabled="busy"><p class="nexus-description">已被 API key 使用的预设不能删除，请先解除对应的 key 绑定。</p><template #footer><button class="button" :disabled="busy" @click="deleteTarget = null">取消</button><button class="button danger-solid" :disabled="busy" @click="remove">删除预设</button></template></AppDialog>
    <AppDialog v-model="switchOpen" title="放弃未保存的修改" description="当前预设还有未保存的修改。"><p class="nexus-description">继续切换会放弃这些修改，并打开选中的预设。</p><template #footer><button class="button" @click="switchTarget = null">继续编辑</button><button class="button primary" @click="discardAndSwitch">放弃修改并切换</button></template></AppDialog>
  </div>
</template>

<style scoped>
.preset-module-bar { display: flex; gap: 20px; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.preset-module-bar > div { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.preset-module-bar p, .preset-notice p { font-size: 13px; color: var(--muted); line-height: 1.8; }
.preset-notice { margin-bottom: 22px; }
.preset-workspace { display: grid; grid-template-columns: minmax(230px, .7fr) minmax(0, 2fr); gap: 20px; align-items: start; }
.preset-library { padding: 20px; }
.preset-search { width: 100%; min-width: 0; margin-bottom: 15px; }
.preset-search input { width: 100%; min-width: 0; }
.preset-list { display: grid; gap: 2px; }
.preset-list-item { border: 0; background: transparent; padding: 13px 11px; border-radius: 5px; display: grid; gap: 5px; text-align: left; transition: background .16s; }
.preset-list-item:hover { background: #f5f6f0; }.preset-list-item.active { background: #edf1e5; }
.preset-list-item strong { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.preset-list-item span { color: var(--muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.preset-list-item small { font-size: 11px; }.preset-compatible { color: var(--green); }.preset-incompatible { color: var(--amber); }
.preset-editor-heading { display: flex; gap: 18px; justify-content: space-between; flex-wrap: wrap; margin-bottom: 22px; }
.preset-editor-heading h2 { font-size: 20px; margin-top: 4px; overflow-wrap: anywhere; }.preset-editor-heading p { color: var(--muted); font-size: 12px; margin-top: 7px; }
.preset-editor-tabs { margin: 5px 0 0; }
.preset-section-intro { color: var(--muted); font-size: 12px; line-height: 1.9; }
.preset-prompts { display: grid; gap: 16px; }
.preset-prompt { display: grid; gap: 14px; padding: 17px 0; border-bottom: 1px solid var(--border); }
.preset-prompt-toolbar { display: flex; align-items: center; gap: 15px; justify-content: space-between; }
.preset-prompt-toggle { display: flex; gap: 9px; align-items: center; font-size: 14px; font-weight: 550; overflow-wrap: anywhere; }
.preset-prompt textarea { font-size: 13px; line-height: 1.8; min-height: 130px; }
.preset-prompt select, .preset-editor select { width: 100%; font-size: 13px; }
.preset-sampling-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-top: 18px; }
.preset-compatibility { margin-top: 22px; padding: 15px 17px; background: #faf5eb; border-left: 3px solid #c4a574; font-size: 12px; line-height: 1.9; }
.preset-compatibility.supported { background: #f2f6ed; border-left-color: #83996b; }
.preset-compatibility strong { font-size: 13px; }.preset-compatibility ul { margin: 8px 0 0; padding-left: 17px; }.preset-compatibility li { margin-top: 7px; overflow-wrap: anywhere; }.preset-compatibility li > span { color: var(--amber); margin-right: 8px; }.preset-compatibility li.error > span { color: var(--red); }.preset-compatibility code { display: block; font-size: 11px; color: var(--muted); }.preset-compatibility p { color: var(--muted); }
.preset-empty-editor { min-height: 360px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 16px; padding: 36px; }
.preset-empty-editor > .iconify { font-size: 34px; color: #7e9169; }.preset-empty-editor h2 { font-size: 22px; }.preset-empty-editor p { color: var(--muted); max-width: 50ch; font-size: 13px; line-height: 1.9; }
.preset-key-routes .preset-route-picker { margin-top: 22px; }
.preset-file-input { align-self: flex-start; }
.preset-key-select { max-width: 640px; }.preset-key-select select { width: 100%; font-size: 13px; }
@media (max-width: 1100px) { .preset-workspace { grid-template-columns: minmax(190px, .65fr) minmax(0, 2fr); }.preset-library { padding: 15px; } }
@media (max-width: 780px) { .preset-workspace { grid-template-columns: 1fr; }.preset-module-bar { align-items: flex-start; flex-wrap: wrap; }.preset-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }.preset-library .state-box { padding: 22px 12px; }.preset-empty-editor { min-height: 270px; padding: 24px; } }
@media (max-width: 480px) { .preset-sampling-grid, .preset-list, .preset-editor .form-row { grid-template-columns: 1fr; }.preset-editor { padding: 18px; }.preset-prompt-toolbar { flex-wrap: wrap; }.preset-prompt-toolbar .inline-actions { margin-left: auto; }.preset-editor-heading h2 { font-size: 19px; } }
</style>
