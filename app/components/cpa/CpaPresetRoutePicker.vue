<script setup lang="ts">
interface CpaPresetAccount { accountId: string; credentialName: string; prefix: string; supported: boolean; message?: string }
const props = defineProps<{ credentialName?: string; accountId?: string }>()
const emit = defineEmits<{ saved: [] }>()
const stableAccountId = ref('')
const { data, pending, error, refresh } = await useFetch<{ accounts: CpaPresetAccount[] }>('/api/presets/cpa-routes', { key: 'nexus-preset-cpa-routes' })
const account = computed(() => data.value?.accounts.find(item => (props.accountId && item.accountId === props.accountId) || (props.credentialName && item.credentialName === props.credentialName) || item.accountId === stableAccountId.value))
watch(() => [props.credentialName, props.accountId], () => { stableAccountId.value = '' })
watch(account, value => { if (value) stableAccountId.value = value.accountId }, { immediate: true })
async function saved() { await refresh(); emit('saved') }
</script>
<template>
  <div class="preset-credential-route">
    <p class="nexus-description">这个账号的预设按独占模型前缀选择。不带前缀的账号池调用使用 CPA 模块默认路由。</p>
    <AppState v-if="error" :error="error" compact @retry="refresh()" />
    <AppState v-else-if="pending && !data" compact loading />
    <template v-else>
      <p v-if="account?.prefix" class="preset-credential-example">调用模型示例：<code>{{ account.prefix }}/原模型名</code></p>
      <p v-else-if="account?.supported" class="preset-credential-help">选择预设时会为这个账号设置唯一前缀。保存后，使用下方显示的前缀模型名调用。</p>
      <p v-if="account?.message || !account" class="preset-credential-help">{{ account?.message || '没有找到此凭证的可用路由，请重新读取凭证或检查内核状态。' }}</p>
      <PresetRoutePicker v-if="account" module-id="cpa" :account-id="account.accountId" title="这个 CPA 账号的预设" :unavailable="!account.supported" @saved="saved" />
    </template>
  </div>
</template>
<style scoped>
.preset-credential-route { margin-top: 22px; padding: 22px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin-bottom: 22px; }
.preset-credential-example, .preset-credential-help { font-size: 12px; line-height: 1.8; margin-bottom: 18px; color: var(--muted); overflow-wrap: anywhere; }
.preset-credential-example code { color: var(--ink); }
</style>
