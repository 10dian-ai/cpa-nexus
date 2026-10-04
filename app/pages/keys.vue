<script setup lang="ts">
useHead({ title: 'API Key · CPA Nexus' })
const legacyLoaded = ref(false)
function loadLegacyKeys(event: Event) {
  if ((event.target as HTMLDetailsElement).open) legacyLoaded.value = true
}
</script>

<template>
  <AppPageHeader title="API Key" description="模型 Key 按所选分组调用各来源的模型，统一使用 /v1 入口。外调管理 Key 用于 CommandCode 的账号管理接口。" />
  <div class="form-stack">
    <KeyManager />
    <details class="raw-details" @toggle="loadLegacyKeys">
      <summary><UIcon name="i-ph-clock-counter-clockwise-bold" />CPA 历史客户端密钥</summary>
      <div v-if="legacyLoaded" class="legacy-keys">
        <p class="nexus-description">这里保留 CPA 内核原有的客户端密钥。建议在上方创建模型 API Key 并选择调用分组，再更新客户端配置；确认调用正常后可移除历史客户端密钥。平台内部凭证由平台保留。</p>
        <CpaGate><CpaClientKeys /></CpaGate>
      </div>
    </details>
  </div>
</template>

<style scoped>
.legacy-keys { display: flex; flex-direction: column; gap: 16px; padding: 0 20px 20px; }
</style>
