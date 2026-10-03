<script setup lang="ts">
import type { PresetSummary, KeyPresetBinding } from '#shared/presets'
const props = withDefaults(defineProps<{ keyId: string; title?: string; description?: string }>(), { title: '这个 API Key 是否经过酒馆模块', description: '' })
const emit = defineEmits<{ saved: [] }>()
const api = useRequestFetch()
const { data: presets, error: presetsError, refresh: refreshPresets } = await useFetch<{ presets: PresetSummary[]; moduleEnabled: boolean }>('/api/presets?view=summary', { key: 'nexus-preset-summaries' })
const { data: routes, error: routesError, refresh: refreshRoutes } = await useFetch<{ bindings: KeyPresetBinding[] }>('/api/presets/routes', { key: 'nexus-preset-routes' })
const binding = computed(() => routes.value?.bindings.find(item => item.keyId === props.keyId))
const usesPresets = (value: KeyPresetBinding | undefined) => value?.mode === 'stack' || value?.mode === 'preset'
const presetEnabled = ref(false)
const { busy, run } = useApiAction()
watch(binding, value => { presetEnabled.value = usesPresets(value) }, { immediate: true })
const dirty = computed(() => presetEnabled.value !== usesPresets(binding.value))
const activePresets = computed(() => presets.value?.presets.filter(item => item.enabled) || [])
async function save() {
  const result = await run(() => api('/api/presets/routes', {
    method: 'PUT', body: { keyId: props.keyId, mode: presetEnabled.value ? 'stack' : 'bypass', presetId: null },
  }), 'API Key 的酒馆路由已保存')
  if (result.ok) { await refreshRoutes(); emit('saved') }
}
</script>
<template>
  <section class="preset-route-picker">
    <div class="panel-heading"><h3>{{ title }}</h3><NuxtLink to="/presets" class="text-link">管理预设<UIcon name="i-ph-arrow-up-right-bold" /></NuxtLink></div>
    <p v-if="description" class="nexus-description">{{ description }}</p>
    <AppState v-if="presetsError || routesError" :error="presetsError || routesError" compact @retry="refreshPresets(); refreshRoutes()" />
    <form v-else class="form-stack" @submit.prevent="save">
      <p v-if="presets && !presets.moduleEnabled" class="preset-route-note">酒馆模块已停用，当前请求保持直连。可以保存选择，启用模块后生效。</p>
      <fieldset class="form-stack" :disabled="busy || !presets || !routes">
        <label class="field"><span>是否经过酒馆模块</span><select v-model="presetEnabled"><option :value="false">普通模型调用</option><option :value="true">经过酒馆模块，叠加已开启预设</option></select><small v-if="!presetEnabled">直接使用客户端提交的消息和参数。</small><small v-else>此 Key 的调用会按酒馆模块中的顺序共同应用所有已开启预设。</small></label>
        <div v-if="presetEnabled" class="preset-stack-summary">
          <span v-if="activePresets.length">已开启 {{ activePresets.length }} 个预设：{{ activePresets.map(item => item.name).join('、') }}</span>
          <span v-else>尚未开启预设，当前保持普通调用。可在预设管理中开启一个或多个预设。</span>
        </div>
        <div class="form-actions"><button class="button small primary" :disabled="!dirty">{{ busy ? '正在保存' : '保存路由' }}</button><span v-if="dirty" class="muted small-text">有未保存修改</span></div>
      </fieldset>
    </form>
  </section>
</template>
<style scoped>
.preset-route-picker h3 { font-size: 15px; font-weight: 600; }
.preset-route-note { font-size: 12px; line-height: 1.8; color: var(--amber); padding: 10px 12px; background: var(--amber-bg); border-radius: 5px; }
.preset-stack-summary { font-size: 12px; line-height: 1.8; color: var(--muted); overflow-wrap: anywhere; }
.preset-route-picker select { width: 100%; font-size: 13px; }
</style>
