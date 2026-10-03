<script setup lang="ts">
useHead({ title: '凭证与授权 · CPA Nexus' })
const tab = ref('credentials')
</script>
<template><AppPageHeader title="凭证与授权" description="管理 CPA 文件凭证、运行时账号和渠道授权。" /><CpaGate><div class="nexus-tabs" role="tablist" aria-label="凭证管理"><button role="tab" :aria-selected="tab === 'credentials'" @click="tab = 'credentials'">凭证列表</button><button role="tab" :aria-selected="tab === 'oauth'" @click="tab = 'oauth'">OAuth 授权</button><button role="tab" :aria-selected="tab === 'vertex'" @click="tab = 'vertex'">Vertex 服务账号</button><button role="tab" :aria-selected="tab === 'providers'" @click="tab = 'providers'">授权渠道配置</button></div><CpaCredentials v-if="tab === 'credentials'" /><CpaOAuth v-else-if="tab === 'oauth'" /><CpaVertex v-else-if="tab === 'vertex'" /><CpaResourceEditor v-else path="config/oauth" title="OAuth 配置" description="配置凭证目录、自动刷新、渠道设置与模型别名；账号令牌由 CPA 凭证存储管理。" writable allow-create /></CpaGate></template>
