<script setup lang="ts">
import type { GroupAccountView, RoutingGroupView } from '#shared/groups'
import type { ModuleView } from '#shared/modules'
type AccountSource = GroupAccountView & { routingPrefix?: string; missing?: boolean }
interface InventoryIssue { moduleId: 'cpa' | 'commandcode'; message: string }
useHead({ title: '账号调用分组 · CPA Nexus' })
const route = useRoute(), api = useRequestFetch()
const groups = await useFetch<{ items: RoutingGroupView[]; defaultGroupId: string }>('/api/groups', { key: 'nexus-routing-groups' })
const modules = await useFetch<{ modules: ModuleView[] }>('/api/modules', { key: 'nexus-modules' })
const moduleFilter = ref<'cpa' | 'commandcode'>(route.query.module === 'commandcode' ? 'commandcode' : 'cpa')
watch(() => route.query.module, value => { moduleFilter.value = value === 'commandcode' ? 'commandcode' : 'cpa' })
watch(moduleFilter, value => { if (route.query.module !== value) navigateTo({ path: route.path, query: { ...route.query, module: value } }, { replace: true }) })
const groupFilter = ref(typeof route.query.group === 'string' ? route.query.group : '')
const sourceQuery = computed(() => ({ moduleId: moduleFilter.value }))
const { data, pending, error, refresh } = await useFetch<{ items: AccountSource[]; issues?: InventoryIssue[] }>('/api/groups/accounts', { query: sourceQuery })
useLiveRefresh(() => Promise.all([refresh(), groups.refresh()]))
const search = ref('')
const visible = computed(() => (data.value?.items || []).filter(account => (!groupFilter.value || account.groupIds.includes(groupFilter.value)) && [account.name, account.provider, account.sourceId].some(value => value.toLowerCase().includes(search.value.trim().toLowerCase()))))
const { busy, run } = useApiAction()
const editing = ref<AccountSource | null>(null), selected = ref<string[]>([])
const editOpen = computed({ get: () => !!editing.value, set: value => { if (!value) editing.value = null } })
const cleaning = ref<AccountSource | null>(null)
const cleanOpen = computed({ get: () => !!cleaning.value, set: value => { if (!value) cleaning.value = null } })
const canSave = computed(() => selected.value.length > 0 && !!groups.data.value && !groups.error.value && editing.value?.routingSupported !== false)
function startEdit(account: AccountSource) { selected.value = [...account.groupIds].sort(); editing.value = account }
function names(account: AccountSource) { return account.groupIds.map(id => groups.data.value?.items.find(group => group.id === id)?.name || account.groupNames[account.groupIds.indexOf(id)] || '未读取分组').join('、') }
function moduleEnabled(id: string) { return modules.data.value?.modules.find(module => module.id === id)?.enabled !== false }
async function save() {
  const account = editing.value
  if (!account || !canSave.value) return
  const result = await run(() => api('/api/groups/accounts', { method: 'PATCH', body: { moduleId: account.moduleId, sourceType: account.sourceType, sourceId: account.sourceId, groupIds: [...selected.value] } }), '账号调用分组已保存')
  if (result.ok) { editing.value = null; await refresh(); await groups.refresh() }
}
async function reload() { await Promise.all([refresh(), groups.refresh(), modules.refresh()]) }
async function cleanSource() {
  const account = cleaning.value
  if (!account?.missing) return
  const result = await run(() => api('/api/groups/accounts', { method: 'DELETE', body: { moduleId: account.moduleId, sourceType: account.sourceType, sourceId: account.sourceId } }), '不存在来源的分组关联已清理')
  if (result.ok) { cleaning.value = null; await refresh(); await groups.refresh() }
}
</script>
<template>
  <NuxtLink to="/groups" class="back-link"><UIcon name="i-ph-arrow-left-bold" />返回调用分组</NuxtLink>
  <AppPageHeader title="账号调用分组" description="集中管理 CPA 凭证、上游 API 来源和 Command Code 账号。每个来源可加入多个分组，模型 Key 按共同启用分组分流。"><NuxtLink to="/groups?create=1" class="button primary"><UIcon name="i-ph-plus-bold" />创建分组</NuxtLink><NuxtLink to="/keys" class="button"><UIcon name="i-ph-key-bold" />配置模型 Key</NuxtLink><button class="button" :disabled="pending || busy" @click="reload"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新来源</button></AppPageHeader>
  <div class="nexus-tabs" role="tablist" aria-label="来源模块"><button role="tab" :aria-selected="moduleFilter === 'cpa'" @click="moduleFilter = 'cpa'">CPA 凭证与来源</button><button role="tab" :aria-selected="moduleFilter === 'commandcode'" @click="moduleFilter = 'commandcode'">CommandCode 账号</button></div><AppState v-if="groups.error.value" :error="groups.error.value" compact title="分组读取失败" @retry="groups.refresh()" />
  <div v-for="issue in data?.issues || []" :key="issue.moduleId" class="notice warning-notice inventory-notice" role="alert"><UIcon name="i-ph-warning-circle-bold" /><div><strong>{{ issue.moduleId === 'cpa' ? 'CPA' : 'Command Code' }} 来源暂时读取失败</strong><p>{{ issue.message }}</p><p class="small-text muted">当前显示已读取的账号来源，已有分组关联仍保留。</p><button class="button small" :disabled="pending || busy" @click="refresh()">重新读取来源</button></div></div>
  <section class="table-panel"><div class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索账号来源" placeholder="搜索名称、渠道或来源标识"></label><label class="select-field"><span class="sr-only">来源模块</span><select v-model="moduleFilter"><option value="cpa">CPA 凭证与来源</option><option value="commandcode">Command Code</option></select></label><label class="select-field"><span class="sr-only">按调用分组筛选</span><select v-model="groupFilter"><option value="">全部调用分组</option><option v-for="group in groups.data.value?.items || []" :key="group.id" :value="group.id">{{ group.name }}</option></select></label><span class="small-text muted">已读取 {{ visible.length }} 个来源</span></div>
    <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="!data" :loading="pending" /><AppState v-else-if="!visible.length" :title="data.issues?.length ? '来源读取未完成' : '没有匹配的账号来源'" :description="data.issues?.length ? '请重试读取来源。读取失败不会删除已有分组关联。' : '调整筛选，或先导入 CPA 凭证、配置上游 API 来源及 Command Code 账号。'" icon="i-ph-users-three-bold"><NuxtLink v-if="!data.issues?.length" to="/cpa/credentials" class="button">CPA 凭证</NuxtLink><NuxtLink v-if="!data.issues?.length && moduleEnabled('commandcode')" to="/accounts" class="button">Command Code 账号</NuxtLink></AppState>
    <div v-else class="table-scroll"><table class="data-table"><thead><tr><th>账号 / 来源</th><th>所属模块</th><th>渠道</th><th>调用分组</th><th>状态</th><th class="align-right">操作</th></tr></thead><tbody><tr v-for="account in visible" :key="account.id"><td><NuxtLink v-if="account.moduleId === 'commandcode'" :to="'/accounts/' + account.sourceId" class="account-name">{{ account.name }}</NuxtLink><strong v-else>{{ account.name }}</strong><div class="cell-secondary mono source-id">{{ account.sourceId }}</div><div v-if="account.message" class="cell-secondary source-message">{{ account.message }}</div></td><td>{{ account.moduleId === 'cpa' ? 'CPA 核心' : 'Command Code' }}<div v-if="!moduleEnabled(account.moduleId)" class="cell-secondary">模块已停用</div></td><td>{{ account.provider }}</td><td class="wrap-cell group-cell">{{ names(account) }}</td><td><StatusBadge :status="account.enabled ? 'enabled' : 'disabled'" :label="account.missing ? '来源不存在' : account.enabled ? '已启用' : '已停用'" /><div v-if="!account.missing && account.routingSupported === false" class="cell-error">此来源暂不支持分组路由</div></td><td><div class="inline-actions justify-end"><button v-if="account.missing" class="button small danger" :disabled="busy" @click="cleaning = account">清理分组关联</button><button v-else class="button small" :disabled="busy || !groups.data.value || !!groups.error.value || account.routingSupported === false" @click="startEdit(account)"><UIcon name="i-ph-pencil-simple-bold" />编辑分组</button></div></td></tr></tbody></table></div>
    <div class="table-footnote">同一分组可包含不同模块的账号。模型 Key 只选择调用分组，调用时根据模型和可用来源自动分流；外调服务 Key 继续用于账号导入与状态查询。</div>
  </section>
  <AppDialog v-model="editOpen" title="编辑账号调用分组" :description="editing?.name" :close-disabled="busy"><form id="source-group-form" class="form-stack" @submit.prevent="save"><GroupSelector v-model="selected" :groups="groups.data.value?.items || []" :disabled="busy || !groups.data.value || !!groups.error.value" description="此来源可供与它有共同启用分组的模型 Key 调用。取消原分组后，该分组的 Key 将不再调用此来源。" /><p v-if="editing?.routingPrefix" class="small-text muted">分组设置也会应用到 CPA 中该来源的调用路由。</p></form><template #footer><button class="button" :disabled="busy" @click="editing = null">取消</button><button form="source-group-form" class="button primary" :disabled="busy || !canSave">保存分组</button></template></AppDialog>
  <AppDialog v-model="cleanOpen" title="清理不存在来源的分组关联" :description="cleaning?.name" :close-disabled="busy"><p class="nexus-description">此来源目前不在 CPA 账号清单中。清理只移除本平台记录的分组关联，不会删除 CPA 账号或凭证。</p><p class="small-text muted">如果只是暂时停用来源或插件，可以保留关联，来源恢复后继续使用原分组。清理后重新出现的来源会回到默认分组。</p><template #footer><button class="button" :disabled="busy" @click="cleaning = null">保留关联</button><button class="button danger-solid" :disabled="busy" @click="cleanSource">清理分组关联</button></template></AppDialog>
</template>
<style scoped>
.table-toolbar .search-field { flex: 1; min-width: 0; max-width: 440px; }.table-toolbar input { min-width: 0; width: 100%; }.source-id { max-width: 370px; overflow-wrap: anywhere; }.source-message { white-space: normal; max-width: 370px; line-height: 1.65; }.group-cell { min-width: 150px; max-width: 330px; }
@media(max-width:720px) { .table-toolbar .search-field { flex-basis: 100%; max-width: none; }.table-toolbar .select-field { flex: 1; min-width: 130px; }.table-toolbar > .small-text { flex-basis: 100%; } }
</style>
