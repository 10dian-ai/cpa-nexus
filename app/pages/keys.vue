<script setup lang="ts">
useHead({ title: 'API Key · CPA Nexus' })
const legacyLoaded = ref(false)
function loadLegacyKeys(event: Event) {
  if ((event.target as HTMLDetailsElement).open) legacyLoaded.value = true
}
</script>

<template>
  <AppPageHeader title="API Key" description="统一管理调用密钥。模型 API Key 绑定一个模块，客户端使用同一个模型入口。" />
  <div class="form-stack">
    <KeyManager />
    <details class="raw-details" @toggle="loadLegacyKeys">
      <summary><UIcon name="i-ph-clock-counter-clockwise-bold" />CPA 历史客户端密钥</summary>
      <div v-if="legacyLoaded" class="legacy-keys">
        <p class="nexus-description">这里保留 CPA 内核原有的客户端密钥。建议在上方创建绑定 CPA 的模型 API Key，再更新客户端配置；确认调用正常后可移除历史客户端密钥。平台内部凭证由平台保留。</p>
        <CpaGate><CpaClientKeys /></CpaGate>
      </div>
    </details>
  </div>
</template>

<style scoped>
.legacy-keys { display: flex; flex-direction: column; gap: 16px; padding: 0 20px 20px; }
</style>
