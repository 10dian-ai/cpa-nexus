<script setup lang="ts">
import { parsePluginField, pluginConfigFields, pluginFieldText, pluginObject, type PluginConfigField } from '~/utils/cpa-plugins'

const props = defineProps<{ plugin: Record<string, unknown> }>()
const id = computed(() => cpaDisplay(props.plugin.id, ''))
const endpoint = computed(() => cpaManagementUrl(`config/plugins/configs/${encodeURIComponent(id.value)}`))
const { data, pending, error, refresh } = await useFetch<unknown>(endpoint, { key: `cpa-plugin-configuration-${id.value}` })
const fields = computed(() => pluginConfigFields(props.plugin))
const source = shallowRef<Record<string, unknown>>({})
const baseline = ref('')
const draft = ref('')
const rawOpen = ref(false)
const resetOpen = ref(false)
const editing = ref<PluginConfigField | null>(null)
const fieldValue = ref('')
const validation = ref('')
const { busy, run } = useApiAction()
const dirty = computed(() => !!baseline.value && JSON.stringify(source.value) !== baseline.value)
const missing = computed(() => error.value?.statusCode === 404 || error.value?.status === 404)
const dialogOpen = computed({ get: () => !!editing.value, set: value => { if (!value) editing.value = null } })
watch(data, value => {
  if (value === undefined || value === null || dirty.value) return
  source.value = JSON.parse(JSON.stringify(pluginObject(value)))
  baseline.value = JSON.stringify(source.value)
}, { immediate: true })
watch(missing, value => { if (value && !baseline.value) baseline.value = JSON.stringify(source.value) }, { immediate: true })
function edit(field: PluginConfigField) {
  fieldValue.value = pluginFieldText(source.value[field.name], field)
  validation.value = ''
  editing.value = field
}
function applyField() {
  if (!editing.value) return
  try {
    source.value = { ...source.value, [editing.value.name]: parsePluginField(editing.value, fieldValue.value) }
    editing.value = null
    validation.value = ''
  } catch (caught) { validation.value = (caught as Error).message }
}
function unset(field: PluginConfigField) {
  const next = { ...source.value }
  delete next[field.name]
  source.value = next
}
function openRaw() { draft.value = JSON.stringify(source.value, null, 2); validation.value = ''; rawOpen.value = true }
function applyRaw() {
  try {
    const value: unknown = JSON.parse(draft.value)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件配置必须是 JSON 对象。')
    source.value = value as Record<string, unknown>
    rawOpen.value = false
    validation.value = ''
  } catch (caught) { validation.value = (caught as Error).message }
}
async function save() {
  const result = await run(() => $fetch(endpoint.value, { method: 'PUT', body: JSON.stringify(source.value), headers: { 'content-type': 'application/json' } }), '插件配置已保存')
  if (result.ok) {
    baseline.value = JSON.stringify(source.value)
    await refresh()
    await refreshNuxtData(['cpa-installed-plugins', 'cpa-management-capabilities'])
  }
}
async function reset() {
  const result = await run(() => $fetch(endpoint.value, { method: 'DELETE' }), '插件配置已重置')
  if (result.ok) { resetOpen.value = false; source.value = {}; baseline.value = JSON.stringify({}); await refresh(); await refreshNuxtData(['cpa-installed-plugins', 'cpa-management-capabilities']) }
}
function restore() { source.value = JSON.parse(baseline.value); validation.value = '' }
function fieldLabel(field: PluginConfigField) {
  const value = source.value[field.name]
  if (value === undefined) return '使用插件默认值'
  if (field.type === 'boolean') return value === true ? '开启' : value === false ? '关闭' : '当前值与声明类型不同'
  if (Array.isArray(value)) return `${value.length} 项`
  if (value && typeof value === 'object') return `${Object.keys(value).length} 个字段`
  return String(value) || '空字符串'
}
</script>

<template>
  <section class="panel plugin-configuration">
    <div class="panel-heading"><h2>{{ cpaDisplay((plugin.metadata as Record<string, unknown> | undefined)?.name || plugin.id) }} 配置</h2><div class="inline-actions"><button class="button small" :disabled="pending || busy || dirty" @click="refresh()">重新读取</button><button class="button small" :disabled="busy" @click="openRaw">编辑完整 JSON</button><button class="button small danger" :disabled="busy || !baseline" @click="resetOpen = true">重置配置</button></div></div>
    <AppState v-if="error && !missing" :error="error" compact @retry="refresh()" />
    <AppState v-else-if="pending && !baseline" compact loading />
    <template v-else>
      <p class="nexus-description">字段名称、类型和选项来自当前插件声明。未设置的字段使用插件默认值，未知字段保留在完整 JSON 中。</p>
      <ul v-if="fields.length" class="plugin-field-list"><li v-for="field in fields" :key="field.name"><div><strong class="mono">{{ field.name }}</strong><p v-if="field.description">{{ field.description }}</p><span class="plugin-field-value">{{ fieldLabel(field) }}</span></div><div class="inline-actions"><button v-if="source[field.name] !== undefined" class="button small" :disabled="busy" @click="unset(field)">使用默认</button><button class="icon-button" :disabled="busy" :aria-label="`编辑插件字段 ${field.name}`" @click="edit(field)"><UIcon name="i-ph-pencil-simple-bold" /></button></div></li></ul>
      <p v-else class="nexus-empty-note">此插件未声明可视化字段，可通过“编辑完整 JSON”配置全部原生参数。</p>
      <div class="nexus-editor-footer"><span class="small-text muted">{{ dirty ? '有未保存的修改' : '已读取当前配置' }} · 部分插件配置在重启内核后生效</span><div class="inline-actions"><button class="button" :disabled="busy || !dirty" @click="restore">还原修改</button><button class="button primary" :disabled="busy || !dirty" @click="save">保存插件配置</button></div></div>
    </template>
  </section>
  <AppDialog v-model="dialogOpen" :title="editing ? `编辑 ${editing.name}` : '编辑插件字段'" :description="editing?.description" :close-disabled="busy" wide>
    <form v-if="editing" id="plugin-field-form" class="form-stack" @submit.prevent="applyField"><label class="field"><span>{{ editing.name }} <small>{{ editing.type }}</small></span><select v-if="editing.type === 'boolean'" v-model="fieldValue"><option value="" disabled>选择值</option><option value="true">开启</option><option value="false">关闭</option></select><select v-else-if="editing.type === 'enum'" v-model="fieldValue"><option value="" disabled>选择值</option><option v-for="value in editing.enumValues" :key="value" :value="value">{{ value }}</option></select><input v-else-if="['number', 'integer'].includes(editing.type)" v-model="fieldValue" type="number" :step="editing.type === 'integer' ? '1' : 'any'"><textarea v-else v-model="fieldValue" :class="{ 'nexus-code-editor': editing.type !== 'string' }" rows="8" spellcheck="false" /></label><p v-if="validation" class="inline-error" role="alert">{{ validation }}</p></form>
    <template #footer><button class="button" @click="editing = null">取消</button><button class="button primary" form="plugin-field-form">应用修改</button></template>
  </AppDialog>
  <AppDialog v-model="rawOpen" title="编辑完整插件配置" description="全部插件原生字段均可在这里编辑。应用后仍需点击保存插件配置。" wide :close-disabled="busy"><textarea v-model="draft" class="nexus-code-editor" rows="18" spellcheck="false" aria-label="插件完整配置 JSON" /><p v-if="validation" class="inline-error" role="alert">{{ validation }}</p><template #footer><button class="button" @click="rawOpen = false">取消</button><button class="button primary" @click="applyRaw">应用 JSON</button></template></AppDialog>
  <AppDialog v-model="resetOpen" title="重置插件配置" description="恢复插件默认配置" :close-disabled="busy"><p class="nexus-description">这会删除该插件在 CPA 配置中的自定义节点，插件将恢复默认值。确定要继续吗？</p><template #footer><button class="button" :disabled="busy" @click="resetOpen = false">取消</button><button class="button danger-solid" :disabled="busy" @click="reset">确认重置</button></template></AppDialog>
</template>

<style scoped>
.plugin-field-list { list-style: none; padding: 0; margin: 18px 0; }
.plugin-field-list li { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 15px 0; border-top: 1px solid var(--border); }
.plugin-field-list li > div:first-child { min-width: 0; }
.plugin-field-list strong { font-size: 12px; overflow-wrap: anywhere; }
.plugin-field-list p { color: var(--muted); font-size: 12px; line-height: 1.7; margin-top: 5px; }
.plugin-field-value { display: block; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50ch; margin-top: 6px; }
.plugin-field-list .inline-actions { flex-shrink: 0; }
@media (max-width: 600px) { .plugin-field-list li { align-items: start; }.plugin-field-list .inline-actions { flex-direction: column-reverse; } }
</style>
