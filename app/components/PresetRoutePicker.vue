<script setup lang="ts">
import type { PresetView, PresetBinding } from '#shared/presets'
const props = withDefaults(defineProps<{ moduleId: string; accountId?: string | null; title?: string; description?: string; unavailable?: boolean }>(), { accountId: null, title: '请求预设', description: '', unavailable: false })
const emit = defineEmits<{ saved: [] }>()
const api = useRequestFetch()
const { data: presets, error: presetsError, refresh: refreshPresets } = await useFetch<{ presets: PresetView[]; moduleEnabled: boolean }>('/api/presets', { key: 'nexus-preset-list' })
const { data: routes, error: routesError, refresh: refreshRoutes } = await useFetch<{ bindings: PresetBinding[] }>('/api/presets/routes', { key: 'nexus-preset-routes' })
const binding = computed(() => routes.value?.bindings.find(item => item.moduleId === props.moduleId && (item.accountId || null) === props.accountId))
const mode = ref<'inherit' | 'bypass' | 'preset'>('inherit')
const presetId = ref('')
const { busy, run } = useApiAction()
watch(binding, value => { mode.value = value?.mode || 'inherit'; presetId.value = value?.presetId || '' }, { immediate: true })
const dirty = computed(() => mode.value !== (binding.value?.mode || 'inherit') || (mode.value === 'preset' && presetId.value !== (binding.value?.presetId || '')))
const validPresets = computed(() => presets.value?.presets.filter(item => item.compatibility.supported) || [])
const inherited = computed(() => props.accountId ? routes.value?.bindings.find(item => item.moduleId === props.moduleId && !item.accountId) : undefined)
const inheritedLabel = computed(() => inherited.value?.mode === 'preset' ? '模块默认：' + (presets.value?.presets.find(item => item.id === inherited.value?.presetId)?.name || '预设已不存在') : '模块默认：直连')
async function save() {
  const result = await run(() => api('/api/presets/routes', { method: 'PUT', body: { moduleId: props.moduleId, accountId: props.accountId, mode: mode.value, presetId: mode.value === 'preset' ? presetId.value : null } }), '请求路由已保存')
  if (result.ok) { await refreshRoutes(); emit('saved') }
}
</script>
<template>
  <section class="preset-route-picker">
    <div class="panel-heading"><h3>{{ title }}</h3><NuxtLink to="/presets" class="text-link">管理预设<UIcon name="i-ph-arrow-up-right-bold" /></NuxtLink></div>
    <p v-if="description" class="nexus-description">{{ description }}</p>
    <AppState v-if="presetsError || routesError" :error="presetsError || routesError" compact @retry="refreshPresets(); refreshRoutes()" />
    <p v-else-if="unavailable" class="nexus-description">此账号暂不支持预设路由。</p>
    <form v-else class="form-stack" @submit.prevent="save">
      <p v-if="presets && !presets.moduleEnabled" class="preset-route-note">预设模块已停用，当前请求保持直连。保存的路由会在启用模块后生效。</p>
      <fieldset class="form-stack" :disabled="busy || !presets || !routes">
        <label class="field"><span>请求处理方式</span><select v-model="mode"><option value="inherit">{{ accountId ? '跟随模块默认设置' : '默认直连' }}</option><option value="bypass">直连，不使用预设</option><option value="preset">使用预设</option></select><small v-if="accountId && mode === 'inherit'">{{ inheritedLabel }}</small><small v-else-if="mode !== 'preset'">保留客户端提交的消息与参数。</small></label>
        <label v-if="mode === 'preset'" class="field"><span>选择预设</span><select v-model="presetId" required><option value="" disabled>请选择兼容预设</option><option v-for="preset in validPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option></select><small v-if="!validPresets.length">尚无兼容预设，请先导入并完成兼容检查。</small></label>
        <div class="form-actions"><button class="button small primary" :disabled="!dirty || (mode === 'preset' && !presetId)">{{ busy ? '正在保存' : '保存路由' }}</button><span v-if="dirty" class="muted small-text">有未保存修改</span></div>
      </fieldset>
    </form>
  </section>
</template>
<style scoped>
.preset-route-picker h3 { font-size: 15px; font-weight: 600; }
.preset-route-note { font-size: 12px; line-height: 1.8; color: var(--amber); padding: 10px 12px; background: var(--amber-bg); border-radius: 5px; }
.preset-route-picker select { width: 100%; font-size: 13px; }
</style>
