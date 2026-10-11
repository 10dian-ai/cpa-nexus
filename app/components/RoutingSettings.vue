<script setup lang="ts">
import type { SystemSettings } from '#shared/types'

/** Settings for unified model keys: upstream timeout and CPA Devin parameter conversion. */
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<{ settings: SystemSettings }>('/api/settings', { key: 'nexus-system-settings' })
const { form, dirty, reset } = useEditableFields(() => data.value?.settings)
const { busy, run } = useApiAction()
const levels = [
  { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high（推荐）' },
  { value: 'xhigh', label: 'xhigh' }, { value: 'max', label: 'max' },
] as const
async function save() {
  if (!form.value) return
  const result = await run(() => api<{ settings: SystemSettings }>('/api/settings', { method: 'PATCH', body: { ...form.value } }), '调用设置已保存')
  if (result.ok) { reset(result.value.settings); await refresh() }
}
useLiveRefresh(refresh)
</script>

<template>
  <section class="panel routing-settings">
    <div class="panel-heading"><h2><UIcon name="i-ph-sliders-horizontal-bold" />调用设置</h2><span class="muted small-text">对所有模型 API Key 生效</span></div>
    <AppState v-if="error" :error="error" compact title="设置读取失败" @retry="refresh()" />
    <AppState v-else-if="!form" :loading="pending" compact />
    <form v-else class="routing-settings-form" @submit.prevent="save">
      <fieldset :disabled="busy">
        <label class="field"><span>上游空闲超时 <small>秒</small></span><input v-model.number="form.upstreamTimeoutSeconds" type="number" required min="30" max="7200" step="1"><small>上游在这段时间内没有返回任何数据才判定超时。长思考模型建议 600 秒以上。</small></label>
        <label class="field"><span>Devin 默认思考程度</span><select v-model="form.devinDefaultEffort"><option v-for="level in levels" :key="level.value" :value="level.value">{{ level.label }}</option></select><small>客户端没有传思考参数（reasoning_effort、thinking、模型名 -high 后缀等）时，CPA Devin 渠道使用的档位。</small></label>
        <label class="toggle-field"><input v-model="form.devinStripSampling" type="checkbox"><span>Devin 思考模式下移除 temperature / top_p / top_k</span></label>
        <p class="small-text muted">客户端（包括 New API）按原始模型名调用即可，例如 claude-opus-4-8。CPAN 会自动换成 CPA 的 devin/ 模型，并把标准思考参数转换成 Devin 档位。</p>
      </fieldset>
      <div class="inline-actions"><button type="button" class="button" :disabled="busy || !dirty" @click="reset()">还原</button><button class="button primary" :disabled="busy || !dirty"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />保存设置</button></div>
    </form>
  </section>
</template>

<style scoped>
.routing-settings-form { display: flex; flex-direction: column; gap: 16px; padding: 4px 20px 20px; }
.routing-settings-form fieldset { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 16px 22px; align-items: start; }
.routing-settings-form fieldset > p, .routing-settings-form .toggle-field { grid-column: 1 / -1; }
.routing-settings-form .toggle-field { padding-top: 0; }
</style>
