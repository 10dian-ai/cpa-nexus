<script setup lang="ts">
import type { SystemSettings } from '#shared/types'
useHead({ title: '平台设置 · CPA Nexus' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<{ settings: SystemSettings }>('/api/settings', { key: 'nexus-system-settings' })
const { form, dirty, reset } = useEditableFields(() => data.value?.settings)
const { busy, run } = useApiAction()
async function save() {
  if (!form.value) return
  const result = await run(() => api<{ settings: SystemSettings }>('/api/settings', { method: 'PATCH', body: { ...form.value } }), '平台设置已保存')
  if (result.ok) { reset(result.value.settings); await refresh() }
}
useLiveRefresh(refresh)
</script>
<template>
  <AppPageHeader title="平台设置" description="整个平台共用的请求与日志参数。各模块自己的参数在模块设置页调整。">
    <button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />重新读取</button>
    <button v-if="form" form="settings-form" class="button primary" :disabled="busy || !dirty"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />保存设置</button>
  </AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" />
  <AppState v-else-if="!data || !form" :loading="pending" />
  <form v-else id="settings-form" class="settings-form" @submit.prevent="save">
    <fieldset :disabled="busy">
      <section class="settings-section">
        <div class="settings-description"><UIcon name="i-ph-timer-bold" /><h2>上游等待</h2><p>模型长时间没有返回任何数据时中止请求，避免连接一直挂着。</p></div>
        <div class="settings-fields"><label class="field"><span>上游静默超时 <small>秒</small></span><input v-model.number="form.upstreamTimeoutSeconds" type="number" required min="30" max="7200" step="1"><small>思考很久的模型需要更长时间；CPA 内核和 Logicc 等模块共用此值。</small></label></div>
      </section>
      <section class="settings-section">
        <div class="settings-description"><UIcon name="i-ph-image-bold" /><h2>请求图片</h2><p>在路由之前统一缩小过大的内嵌图片，所有来源和代理收到的都是缩小后的请求。</p></div>
        <div class="settings-fields">
          <label class="field"><span>图片最长边 <small>像素</small></span><input v-model.number="form.imageMaxEdge" type="number" required min="0" max="8192" step="1"><small>0 表示原样发送，否则需在 512–8192 之间。</small></label>
          <label class="field"><span>缩放质量</span><input v-model.number="form.imageQuality" type="number" required min="40" max="100" step="1"></label>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-description"><UIcon name="i-ph-clock-countdown-bold" /><h2>日志保留</h2><p>保存请求元数据及请求、回复内容，用于查看实际调用情况。</p></div>
        <div class="settings-fields"><label class="field"><span>日志保留期限 <small>天</small></span><input v-model.number="form.logRetentionDays" type="number" required min="1" max="365" step="1"><small>超过期限的日志由后台清理任务删除。</small></label></div>
      </section>
    </fieldset>
    <div class="settings-save-bar"><span>{{ dirty ? '设置有未保存的修改' : '当前设置已保存' }}</span><div class="inline-actions"><button type="button" class="button" :disabled="busy || !dirty" @click="reset()">还原修改</button><button class="button primary" :disabled="busy || !dirty">保存设置</button></div></div>
  </form>
</template>
