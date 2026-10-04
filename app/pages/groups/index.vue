<script setup lang="ts">
import type { RoutingGroupView } from '#shared/groups'
useHead({ title: '调用分组 · CPA Nexus' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<{ items: RoutingGroupView[]; defaultGroupId: string }>('/api/groups', { key: 'nexus-routing-groups' })
useLiveRefresh(refresh)
const search = ref('')
const visible = computed(() => (data.value?.items || []).filter(group => group.name.toLowerCase().includes(search.value.trim().toLowerCase())))
const { busy, run } = useApiAction()
const editing = ref<RoutingGroupView | null>(null), editOpen = ref(false), name = ref(''), description = ref('')
const deleting = ref<RoutingGroupView | null>(null)
const deleteOpen = computed({ get: () => !!deleting.value, set: value => { if (!value) deleting.value = null } })
function startEdit(group?: RoutingGroupView) { editing.value = group || null; name.value = group?.name || ''; description.value = group?.description || ''; editOpen.value = true }
async function save() {
  if (!name.value.trim()) return
  const target = editing.value
  const result = await run(() => api('/api/groups' + (target ? '/' + target.id : ''), { method: target ? 'PATCH' : 'POST', body: { name: name.value.trim(), description: description.value } }), target ? '分组已保存' : '分组已创建')
  if (result.ok) { editOpen.value = false; await refresh() }
}
async function toggle(group: RoutingGroupView) {
  const result = await run(() => api('/api/groups/' + group.id, { method: 'PATCH', body: { enabled: !group.enabled } }), group.enabled ? '分组已停用' : '分组已启用')
  if (result.ok) await refresh()
}
async function remove() {
  const group = deleting.value
  if (!group) return
  const result = await run(() => api('/api/groups/' + group.id, { method: 'DELETE' }), '分组已删除')
  if (result.ok) { deleting.value = null; await refresh() }
}
</script>
<template>
  <AppPageHeader title="调用分组" description="账号和模型 API Key 都可绑定多个分组。只有共同分组已启用，Key 才能调用该账号的模型。"><NuxtLink to="/groups/accounts" class="button"><UIcon name="i-ph-users-three-bold" />账号分组</NuxtLink><button class="button primary" :disabled="busy" @click="startEdit()"><UIcon name="i-ph-plus-bold" />创建分组</button></AppPageHeader>
  <section class="table-panel">
    <div class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索分组" placeholder="搜索分组名称"></label><span class="small-text muted">{{ data?.items.length || 0 }} 个分组</span><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新</button></div>
    <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" />
    <AppState v-else-if="!visible.length" compact title="没有匹配的分组" description="调整搜索条件，或创建新的分组。" />
    <div v-else class="table-scroll"><table class="data-table"><thead><tr><th>名称</th><th>状态</th><th>关联来源</th><th>关联模型 Key</th><th class="align-right">操作</th></tr></thead><tbody><tr v-for="group in visible" :key="group.id"><td><strong>{{ group.name }}</strong><span v-if="group.isDefault" class="default-label">默认分组</span><div v-if="group.description" class="cell-secondary wrap-cell">{{ group.description }}</div></td><td><StatusBadge :status="group.enabled ? 'enabled' : 'disabled'" :label="group.enabled ? '已启用' : '已停用'" /></td><td><NuxtLink :to="{ path: '/groups/accounts', query: { group: group.id } }" class="text-link">{{ group.accountCount }} 个来源</NuxtLink></td><td>{{ group.keyCount }} 个 Key</td><td><div class="inline-actions justify-end"><button class="button small" :disabled="busy" @click="startEdit(group)">编辑</button><button class="button small" :disabled="busy" @click="toggle(group)">{{ group.enabled ? '停用' : '启用' }}</button><button class="button small danger" :disabled="busy || group.isDefault || group.accountCount > 0 || group.keyCount > 0" :title="group.isDefault ? '默认分组用于新建账号和 Key，不能删除' : group.accountCount || group.keyCount ? '先移除账号和 Key 的绑定，再删除分组' : undefined" @click="deleting = group">删除</button></div></td></tr></tbody></table></div>
    <div class="table-footnote">默认分组用于兼容现有账号和 Key。停用分组会停止它参与分流；账号的其他共同启用分组仍可正常调用。删除分组前需移除全部绑定。</div>
  </section>
  <AppDialog v-model="editOpen" :title="editing ? '编辑分组' : '创建分组'" description="使用名称区分账号用途或客户端，随后将账号和模型 Key 绑定到分组。" :close-disabled="busy"><form id="group-form" class="form-stack" @submit.prevent="save"><label class="field"><span>分组名称</span><input v-model="name" required autofocus :disabled="busy" placeholder="例如：个人使用、团队 A"></label><label class="field"><span>说明 <small>可选</small></span><textarea v-model="description" rows="3" :disabled="busy" placeholder="记录此分组的用途" /></label></form><template #footer><button class="button" :disabled="busy" @click="editOpen = false">取消</button><button class="button primary" form="group-form" :disabled="busy || !name.trim()">{{ editing ? '保存分组' : '创建分组' }}</button></template></AppDialog>
  <AppDialog v-model="deleteOpen" title="删除分组" :description="'确认删除「' + (deleting?.name || '') + '」？'" :close-disabled="busy"><p class="muted">此分组没有绑定账号或模型 Key，删除不会影响其他分组。</p><template #footer><button class="button" :disabled="busy" @click="deleting = null">取消</button><button class="button danger-solid" :disabled="busy" @click="remove">删除分组</button></template></AppDialog>
</template>
<style scoped>.default-label { display: inline-block; margin-left: 10px; font-size: 11px; padding: 2px 7px; color: var(--muted); background: var(--green-bg); border-radius: 4px; }.table-toolbar .search-field { flex: 1; min-width: 0; max-width: 480px; }.table-toolbar input { min-width: 0; width: 100%; }</style>
