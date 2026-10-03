<template>
  <div class="preset-credential-route">
    <p class="nexus-description">酒馆预设按平台模型 API key 配置。选择账号或模型前缀不会改变预设。</p>
    <NuxtLink to="/presets" class="text-link">管理 API key 的酒馆预设</NuxtLink>
  </div>
</template>
<style scoped>
.preset-credential-route { margin-top: 22px; padding: 22px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin-bottom: 22px; }
.preset-credential-example, .preset-credential-help { font-size: 12px; line-height: 1.8; margin-bottom: 18px; color: var(--muted); overflow-wrap: anywhere; }
.preset-credential-example code { color: var(--ink); }
</style>
