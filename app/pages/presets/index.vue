<script setup lang="ts">
import type { GroupPresetSummary, PresetSummary } from '#shared/presets'
import type { GroupListView } from '#shared/groups'
useHead({ title: '预设库 · CPA Nexus' })
const api = useRequestFetch()
const route = useRoute()
const router = useRouter()
const { data: groupsData, pending: groupsPending, error: groupsError } = await useFetch<GroupListView>('/api/groups', { key: 'nexus-routing-groups' })
const requestedGroupId = String(route.query.group || '')
const initialGroupId = groupsData.value?.items.find(group => group.id === requestedGroupId)?.id
  || groupsData.value?.items.find(group => group.id === groupsData.value?.moduleDefaultGroupIds?.cpa)?.id
  || groupsData.value?.items[0]?.id || ''
const selectedGroupId = ref(initialGroupId)
type PresetListItem = PresetSummary | GroupPresetSummary
const { data, pending, error, refresh } = await useFetch<{ presets: PresetListItem[]; moduleEnabled: boolean }>('/api/presets', {
  query: computed(() => ({ view: 'summary', ...(selectedGroupId.value ? { groupId: selectedGroupId.value } : {}) })),
  key: computed(() => `nexus-preset-summaries-${selectedGroupId.value || 'global'}`),
  watch: [selectedGroupId],
})
const { busy, run } = useApiAction()
const search = ref('')
const visible = computed(() => (data.value?.presets || []).filter(preset => preset.name.toLowerCase().includes(search.value.trim().toLowerCase())))
const activeCount = computed(() => data.value?.presets.filter(preset => preset.enabled).length || 0)
function inheritanceLabel(preset: PresetListItem) {
  return 'inherited' in preset ? (preset.inherited ? '继承全局配置' : '本组已覆盖') : ''
}
const groups = computed(() => groupsData.value?.items || [])
const selectedGroup = computed(() => groups.value.find(group => group.id === selectedGroupId.value))
watch(groups, items => {
  if (selectedGroupId.value && items.some(group => group.id === selectedGroupId.value)) return
  const requested = String(route.query.group || '')
  const defaultId = groupsData.value?.moduleDefaultGroupIds?.cpa || ''
  const fallback = items.find(group => group.id === requested)?.id || items.find(group => group.id === defaultId)?.id || items[0]?.id || ''
  if (fallback) selectedGroupId.value = fallback
}, { immediate: true })
watch(selectedGroupId, groupId => {
  if (String(route.query.group || '') === groupId) return
  router.replace({ query: groupId ? { ...route.query, group: groupId } : { ...route.query, group: undefined } })
})
const importOpen = ref(false), importName = ref(''), importText = ref(''), importError = ref(''), reading = ref(false)
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file) return
  reading.value = true; importError.value = ''
  try { importText.value = await file.text(); if (!importName.value) importName.value = file.name.replace(/\.json$/i, '') }
  catch { importError.value = '文件读取失败，请重新选择。' }
  finally { reading.value = false; input.value = '' }
}
async function importPreset() {
  importError.value = ''
  try {
    const result = await run(() => api<PresetSummary>('/api/presets', { method: 'POST', body: { name: importName.value.trim(), sourceJson: parsePresetObject(importText.value) } }), '预设已导入')
    if (result.ok) {
      // A preset is created once and then attached to the currently selected group.
      // This keeps the global library compatible while making the first group choice explicit.
      if (selectedGroupId.value) {
        const attached = await run(() => api('/api/presets/' + encodeURIComponent(result.value.id) + '/group-bindings', { method: 'PATCH', body: { groupId: selectedGroupId.value, enabled: false } }))
        if (!attached.ok) {
          importError.value = '预设已导入，但未能关联当前分组；请稍后在分组预设列表中重试。'
          return
        }
      }
      importOpen.value = false; await refresh(); await navigateTo({ path: '/presets/' + result.value.id, query: selectedGroupId.value ? { group: selectedGroupId.value } : undefined })
    }
  } catch (error) { importError.value = error instanceof Error ? error.message : '请检查 JSON 格式。' }
}
async function toggleModule() {
  const result = await run(() => api('/api/modules', { method: 'PATCH', body: { id: 'presets', enabled: !data.value?.moduleEnabled } }), data.value?.moduleEnabled ? '预设模块已停用' : '预设模块已启用')
  if (result.ok) { await refresh(); await refreshNuxtData('nexus-modules') }
}
async function togglePreset(preset: PresetSummary, event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  const result = await run(() => selectedGroupId.value
    ? api('/api/presets/' + preset.id + '/group-bindings', { method: 'PATCH', body: { groupId: selectedGroupId.value, enabled } })
    : api('/api/presets/' + preset.id, { method: 'PATCH', body: { enabled } }), enabled ? '预设已开启' : '预设已关闭')
  await refresh()
  if (result.ok) await refreshNuxtData('nexus-preset-list')
}
async function movePreset(preset: PresetSummary, direction: -1 | 1) {
  const ids = data.value?.presets.map(item => item.id) || [], index = ids.indexOf(preset.id), next = index + direction
  if (index < 0 || next < 0 || next >= ids.length) return
  ;[ids[index], ids[next]] = [ids[next]!, ids[index]!]
  const result = await run(() => api('/api/presets/order', { method: 'PUT', body: { ids, ...(selectedGroupId.value ? { groupId: selectedGroupId.value } : {}) } }), '叠加顺序已保存')
  if (result.ok) await refresh()
}
</script>
<template>
  <AppState v-if="error && !data" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending || groupsPending" />
  <template v-else><div class="library-status"><span class="status-badge" :class="data.moduleEnabled ? 'green' : 'neutral'"><span class="status-dot" />{{ data.moduleEnabled ? '预设模块已启用' : '预设模块已停用' }}</span><button class="button small" :disabled="busy" @click="toggleModule">{{ data.moduleEnabled ? '停用模块' : '启用模块' }}</button></div>
    <section class="panel group-picker"><div class="group-picker-copy"><strong>选择调用分组</strong><span class="small-text muted">每个分组拥有独立的预设开关、叠加顺序和配置覆盖。</span></div><label class="field group-picker-select"><span class="sr-only">调用分组</span><select v-model="selectedGroupId" :disabled="groupsPending || busy"><option value="" disabled>请选择分组</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}{{ group.enabled ? '' : '（已停用）' }}</option></select></label><NuxtLink to="/groups" class="text-link">管理分组</NuxtLink></section>
    <p v-if="groupsError" class="inline-error" role="alert">分组读取失败：{{ apiErrorMessage(groupsError) }}</p>
    <section class="panel preset-library"><div class="library-tools"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索预设名称" placeholder="搜索预设名称"></label><span class="muted small-text">{{ selectedGroup ? selectedGroup.name + ' · ' : '' }}{{ activeCount }} / {{ data.presets.length }} 已开启</span><button class="icon-button" :disabled="pending || busy" aria-label="刷新预设列表" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" /></button></div><div v-if="visible.length" class="library-list"><article v-for="preset in visible" :key="preset.id" class="library-row"><NuxtLink :to="{ path: '/presets/' + preset.id, query: selectedGroupId ? { group: selectedGroupId } : undefined }" class="library-name"><span>{{ preset.name }}<small v-if="inheritanceLabel(preset)" class="inheritance-label">{{ inheritanceLabel(preset) }}</small></span><UIcon name="i-ph-caret-right-bold" /></NuxtLink><div class="library-actions"><label class="library-switch"><input type="checkbox" role="switch" :checked="preset.enabled" :aria-label="'开启预设 ' + preset.name" :disabled="busy || !selectedGroupId" @change="togglePreset(preset, $event)"><span aria-hidden="true" /></label><button class="icon-button" :disabled="busy || data.presets[0]?.id === preset.id" :aria-label="'上移预设 ' + preset.name" @click="movePreset(preset, -1)"><UIcon name="i-ph-arrow-up-bold" /></button><button class="icon-button" :disabled="busy || data.presets[data.presets.length - 1]?.id === preset.id" :aria-label="'下移预设 ' + preset.name" @click="movePreset(preset, 1)"><UIcon name="i-ph-arrow-down-bold" /></button></div></article></div><AppState v-else compact :title="search ? '没有匹配的预设' : '还没有预设'" :description="selectedGroup ? '当前分组还没有预设绑定；导入预设后可在此分组启用。' : '请先选择调用分组，或导入 JSON 文件。'" /></section>
    <p v-if="!activeCount" class="library-note">当前分组尚未开启预设。启用预设后，选择经过酒馆模块的 Key 才会增加提示词；普通模型 Key 继续正常调用。</p>
  </template>
  <AppDialog v-model="importOpen" title="导入酒馆预设" description="支持 JSON 文件或粘贴内容，文件大小不设上限。" wide :close-disabled="busy || reading"><form id="preset-import-form" class="form-stack" @submit.prevent="importPreset"><label class="field"><span>预设名称</span><input v-model="importName" required :disabled="busy"></label><label class="button file-upload"><UIcon name="i-ph-file-arrow-up-bold" />{{ reading ? '正在读取文件' : '选择 JSON 文件' }}<input class="sr-only" type="file" accept=".json,application/json" :disabled="busy || reading" @change="upload"></label><label class="field"><span>或粘贴 JSON</span><textarea v-model="importText" class="nexus-code-editor" rows="10" spellcheck="false" :disabled="busy || reading" /></label><p v-if="importError" class="inline-error" role="alert">{{ importError }}</p></form><template #footer><button class="button" :disabled="busy || reading" @click="importOpen = false">取消</button><button form="preset-import-form" class="button primary" :disabled="busy || reading || !importName.trim() || !importText.trim()">导入预设</button></template></AppDialog>
</template>
<style scoped>
.library-status { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.group-picker { display: flex; align-items: center; gap: 18px; margin-bottom: 20px; padding: 16px 20px; }.group-picker-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }.group-picker-copy strong { font-size: 14px; }.group-picker-select { width: min(320px, 100%); margin: 0; }.group-picker-select select { width: 100%; }.group-picker > .text-link { white-space: nowrap; }
.preset-library { padding: 0; overflow: hidden; }.library-tools { display: flex; align-items: center; gap: 16px; padding: 20px; border-bottom: 1px solid var(--border); }.library-tools .search-field { flex: 1; min-width: 0; max-width: 520px; }.library-tools input { min-width: 0; width: 100%; }.library-tools > .icon-button { margin-left: auto; }
.library-list { display: grid; }.library-row { display: flex; align-items: center; gap: 20px; justify-content: space-between; min-height: 72px; padding: 20px 24px; color: var(--ink); border-bottom: 1px solid var(--border); font-size: 15px; font-weight: 550; }.library-row:last-child { border-bottom: 0; }.library-row:hover { background: var(--green-bg); }.library-row span { overflow-wrap: anywhere; }.library-row .iconify { flex-shrink: 0; color: var(--muted); }.file-upload { align-self: flex-start; }
.library-name { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; color: inherit; }.inheritance-label { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; font-weight: 400; }.library-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }.library-switch { position: relative; display: inline-flex; padding: 6px 0; cursor: pointer; }.library-switch input { position: absolute; opacity: 0; width: 36px; height: 28px; margin: 0; }.library-switch span { width: 32px; height: 19px; border-radius: 20px; background: #ccd0ca; }.library-switch span::after { content: ''; display: block; width: 13px; height: 13px; margin: 3px; background: white; border-radius: 50%; transition: transform .15s; }.library-switch input:checked + span { background: var(--green); }.library-switch input:checked + span::after { transform: translateX(13px); }.library-switch input:focus-visible + span { outline: 2px solid var(--green); outline-offset: 3px; }.library-switch input:disabled + span { opacity: .5; }.library-note { margin-top: 16px; color: var(--muted); font-size: 13px; line-height: 1.8; }
@media(max-width:600px) { .group-picker { align-items: stretch; flex-direction: column; gap: 10px; padding: 16px; }.group-picker-select { width: 100%; }.group-picker > .text-link { align-self: flex-start; }.library-tools { padding: 16px; gap: 10px; flex-wrap: wrap; }.library-tools .search-field { flex-basis: 100%; max-width: none; }.library-row { padding: 20px 16px; } }
</style>
