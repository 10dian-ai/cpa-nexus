<script setup lang="ts">
import type { PresetSummary } from '#shared/presets'
useHead({ title: '预设库 · CPA Nexus' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<{ presets: PresetSummary[]; moduleEnabled: boolean }>('/api/presets', { query: { view: 'summary' }, key: 'nexus-preset-summaries' })
const { busy, run } = useApiAction()
const search = ref('')
const visible = computed(() => (data.value?.presets || []).filter(preset => preset.name.toLowerCase().includes(search.value.trim().toLowerCase())))
const activeCount = computed(() => data.value?.presets.filter(preset => preset.enabled).length || 0)
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
    if (result.ok) { importOpen.value = false; await refresh(); await navigateTo('/presets/' + result.value.id) }
  } catch (error) { importError.value = error instanceof Error ? error.message : '请检查 JSON 格式。' }
}
async function toggleModule() {
  const result = await run(() => api('/api/modules', { method: 'PATCH', body: { id: 'presets', enabled: !data.value?.moduleEnabled } }), data.value?.moduleEnabled ? '预设模块已停用' : '预设模块已启用')
  if (result.ok) { await refresh(); await refreshNuxtData('nexus-modules') }
}
async function togglePreset(preset: PresetSummary, event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  const result = await run(() => api('/api/presets/' + preset.id, { method: 'PATCH', body: { enabled } }), enabled ? '预设已开启' : '预设已关闭')
  await refresh()
  if (result.ok) await refreshNuxtData('nexus-preset-list')
}
async function movePreset(preset: PresetSummary, direction: -1 | 1) {
  const ids = data.value?.presets.map(item => item.id) || [], index = ids.indexOf(preset.id), next = index + direction
  if (index < 0 || next < 0 || next >= ids.length) return
  ;[ids[index], ids[next]] = [ids[next]!, ids[index]!]
  const result = await run(() => api('/api/presets/order', { method: 'PUT', body: { ids } }), '叠加顺序已保存')
  if (result.ok) await refresh()
}
</script>
<template>
  <AppPageHeader title="预设库" description="开启多个预设后，走酒馆模块的模型 Key 会按这里的顺序叠加使用。点击名称编辑预设详情。"><NuxtLink to="/keys" class="button"><UIcon name="i-ph-key-bold" />API Key 配置</NuxtLink><button class="button primary" :disabled="busy" @click="importOpen = true"><UIcon name="i-ph-upload-simple-bold" />导入预设</button></AppPageHeader>
  <AppState v-if="error && !data" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" />
  <template v-else><div class="library-status"><span class="status-badge" :class="data.moduleEnabled ? 'green' : 'neutral'"><span class="status-dot" />{{ data.moduleEnabled ? '预设模块已启用' : '预设模块已停用' }}</span><button class="button small" :disabled="busy" @click="toggleModule">{{ data.moduleEnabled ? '停用模块' : '启用模块' }}</button></div>
    <section class="panel preset-library"><div class="library-tools"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索预设名称" placeholder="搜索预设名称"></label><span class="muted small-text">{{ activeCount }} / {{ data.presets.length }} 已开启</span><button class="icon-button" :disabled="pending || busy" aria-label="刷新预设列表" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" /></button></div><div v-if="visible.length" class="library-list"><article v-for="preset in visible" :key="preset.id" class="library-row"><NuxtLink :to="'/presets/' + preset.id" class="library-name"><span>{{ preset.name }}</span><UIcon name="i-ph-caret-right-bold" /></NuxtLink><div class="library-actions"><label class="library-switch"><input type="checkbox" role="switch" :checked="preset.enabled" :aria-label="'开启预设 ' + preset.name" :disabled="busy" @change="togglePreset(preset, $event)"><span aria-hidden="true" /></label><button class="icon-button" :disabled="busy || data.presets[0]?.id === preset.id" :aria-label="'上移预设 ' + preset.name" @click="movePreset(preset, -1)"><UIcon name="i-ph-arrow-up-bold" /></button><button class="icon-button" :disabled="busy || data.presets[data.presets.length - 1]?.id === preset.id" :aria-label="'下移预设 ' + preset.name" @click="movePreset(preset, 1)"><UIcon name="i-ph-arrow-down-bold" /></button></div></article></div><AppState v-else compact :title="search ? '没有匹配的预设' : '还没有预设'" description="导入 JSON 文件，或粘贴预设内容。" /></section>
    <p v-if="!activeCount" class="library-note">尚未开启预设。启用预设后，选择经过酒馆模块的 Key 才会增加提示词；普通模型 Key 继续正常调用。</p>
  </template>
  <AppDialog v-model="importOpen" title="导入酒馆预设" description="支持 JSON 文件或粘贴内容，文件大小不设上限。" wide :close-disabled="busy || reading"><form id="preset-import-form" class="form-stack" @submit.prevent="importPreset"><label class="field"><span>预设名称</span><input v-model="importName" required :disabled="busy"></label><label class="button file-upload"><UIcon name="i-ph-file-arrow-up-bold" />{{ reading ? '正在读取文件' : '选择 JSON 文件' }}<input class="sr-only" type="file" accept=".json,application/json" :disabled="busy || reading" @change="upload"></label><label class="field"><span>或粘贴 JSON</span><textarea v-model="importText" class="nexus-code-editor" rows="10" spellcheck="false" :disabled="busy || reading" /></label><p v-if="importError" class="inline-error" role="alert">{{ importError }}</p></form><template #footer><button class="button" :disabled="busy || reading" @click="importOpen = false">取消</button><button form="preset-import-form" class="button primary" :disabled="busy || reading || !importName.trim() || !importText.trim()">导入预设</button></template></AppDialog>
</template>
<style scoped>
.library-status { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.preset-library { padding: 0; overflow: hidden; }.library-tools { display: flex; align-items: center; gap: 16px; padding: 20px; border-bottom: 1px solid var(--border); }.library-tools .search-field { flex: 1; min-width: 0; max-width: 520px; }.library-tools input { min-width: 0; width: 100%; }.library-tools > .icon-button { margin-left: auto; }
.library-list { display: grid; }.library-row { display: flex; align-items: center; gap: 20px; justify-content: space-between; min-height: 72px; padding: 20px 24px; color: var(--ink); border-bottom: 1px solid var(--border); font-size: 15px; font-weight: 550; }.library-row:last-child { border-bottom: 0; }.library-row:hover { background: var(--green-bg); }.library-row span { overflow-wrap: anywhere; }.library-row .iconify { flex-shrink: 0; color: var(--muted); }.file-upload { align-self: flex-start; }
.library-name { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; color: inherit; }.library-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }.library-switch { position: relative; display: inline-flex; padding: 6px 0; cursor: pointer; }.library-switch input { position: absolute; opacity: 0; width: 36px; height: 28px; margin: 0; }.library-switch span { width: 32px; height: 19px; border-radius: 20px; background: #ccd0ca; }.library-switch span::after { content: ''; display: block; width: 13px; height: 13px; margin: 3px; background: white; border-radius: 50%; transition: transform .15s; }.library-switch input:checked + span { background: var(--green); }.library-switch input:checked + span::after { transform: translateX(13px); }.library-switch input:focus-visible + span { outline: 2px solid var(--green); outline-offset: 3px; }.library-switch input:disabled + span { opacity: .5; }.library-note { margin-top: 16px; color: var(--muted); font-size: 13px; line-height: 1.8; }
@media(max-width:600px) { .library-tools { padding: 16px; gap: 10px; flex-wrap: wrap; }.library-tools .search-field { flex-basis: 100%; max-width: none; }.library-row { padding: 20px 16px; } }
</style>
