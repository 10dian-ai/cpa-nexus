<script setup lang="ts">
import type { LogiccAccountView } from '#shared/logicc'
import type { RoutingGroupView } from '#shared/groups'
interface AccountList { items: LogiccAccountView[]; total: number; page: number; pageSize: number }
useHead({ title: 'Logicc 账号 · CPA Nexus' })
const route = useRoute()
const api = useRequestFetch()
const page = ref(1)
const pageSize = 50
const searchInput = ref(typeof route.query.q === 'string' ? route.query.q : '')
const q = ref(searchInput.value)
const status = ref('')
const groupId = ref('')
const { data, pending, error, refresh } = await useFetch<AccountList>('/api/logicc/accounts', { query: { page, pageSize, q, status, groupId } })
const { data: groups } = await useFetch<{ items: RoutingGroupView[] }>('/api/groups', { key: 'nexus-routing-groups' })
useLiveRefresh(refresh)
watch([q, status, groupId], () => { page.value = 1 })

const selected = ref<string[]>([])
watch(() => data.value?.items, items => { const ids = new Set((items || []).map(item => item.id)); selected.value = selected.value.filter(id => ids.has(id)) })
const allSelected = computed(() => !!data.value?.items.length && data.value.items.every(item => selected.value.includes(item.id)))
function toggleAll(checked: boolean) { selected.value = checked ? (data.value?.items || []).map(item => item.id) : [] }

const { busy, run } = useApiAction()
const importOpen = ref(false)
const deleteOpen = ref(false)
async function bulk(action: 'enable' | 'disable' | 'delete' | 'check' | 'login', ids = selected.value) {
  if (!ids.length) return
  const labels = { enable: '账号已启用', disable: '账号已停用', delete: '账号已删除', check: '检测完成', login: '登录完成' }
  const result = await run(() => api<{ affected: number; results: { ok: boolean }[] }>('/api/logicc/accounts/actions', { method: 'POST', body: { action, ids: [...ids] } }), labels[action])
  if (result.ok) { if (action === 'delete') { selected.value = []; deleteOpen.value = false } await refresh() }
}

const editing = ref<LogiccAccountView | null>(null)
const editOpen = computed({ get: () => !!editing.value, set: value => { if (!value) editing.value = null } })
const form = reactive({ label: '', note: '', maxConcurrency: 2, enabled: true, autoLogin: true, groupIds: [] as string[] })
function startEdit(account: LogiccAccountView) {
  Object.assign(form, { label: account.label, note: account.note, maxConcurrency: account.maxConcurrency, enabled: account.enabled, autoLogin: account.autoLogin, groupIds: [...account.groupIds] })
  editing.value = account
}
async function save() {
  const target = editing.value
  if (!target) return
  const result = await run(() => api(`/api/logicc/accounts/${target.id}`, { method: 'PATCH', body: { label: form.label.trim(), note: form.note, maxConcurrency: form.maxConcurrency, enabled: form.enabled, autoLogin: form.autoLogin, ...(form.groupIds.length ? { groupIds: [...form.groupIds] } : {}) } }), '账号已保存')
  if (result.ok) { editing.value = null; await refresh() }
}
function credentialLabel(account: LogiccAccountView) {
  const base = account.credentialKind === 'client' ? '__client 自动续期'
    : account.credentialKind === 'password' ? '邮箱密码登录'
    : `仅 JWT · ${account.tokenExpiresAt ? '到期 ' + formatDate(account.tokenExpiresAt) : '已过期'}`
  const signIn = account.canSignIn ? `${account.loginHint || '邮箱'}${account.autoLogin ? ' · 自动登录' : ' · 已关闭自动登录'}` : ''
  return signIn && account.credentialKind !== 'password' ? `${base} · ${signIn}` : account.credentialKind === 'password' ? `${base}${account.autoLogin ? '' : '（已关闭自动登录）'} · ${account.loginHint || ''}` : base
}
</script>

<template>
  <AppPageHeader title="Logicc 账号" description="每个账号对应一个 Logicc 登录会话。检测会刷新会话并读取模型目录；凭据失效的账号自动退出调度，更新凭据后重新加入。">
    <button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新</button>
    <button class="button primary" @click="importOpen = true"><UIcon name="i-ph-plus-bold" />导入账号</button>
  </AppPageHeader>
  <section class="table-panel">
    <form class="table-toolbar" @submit.prevent="q = searchInput.trim()">
      <label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="searchInput" aria-label="搜索账号" placeholder="名称、备注或会话 ID"><button v-if="searchInput" class="icon-button" type="button" aria-label="清除搜索" @click="searchInput = ''; q = ''"><UIcon name="i-ph-x-bold" /></button></label>
      <button class="button">搜索</button>
      <select v-model="status" aria-label="账号状态"><option value="">全部状态</option><option value="ready">正常</option><option value="pending">待检测</option><option value="needs_login">待登录</option><option value="credential_expired">凭证失效</option><option value="sync_error">同步失败</option></select>
      <select v-model="groupId" aria-label="调用分组"><option value="">全部分组</option><option v-for="group in groups?.items || []" :key="group.id" :value="group.id">{{ group.name }}</option></select>
      <span v-if="pending && data" class="toolbar-updating"><UIcon name="i-ph-circle-notch-bold" class="spinning" />更新中</span>
    </form>
    <div v-if="selected.length" class="selection-bar"><span>已选择 <strong>{{ selected.length }}</strong> 个账号</span><div class="inline-actions">
      <button class="button small" :disabled="busy" @click="bulk('check')">检测</button>
      <button class="button small" :disabled="busy" @click="bulk('enable')">启用</button>
      <button class="button small" :disabled="busy" @click="bulk('disable')">停用</button>
      <button class="button small danger" :disabled="busy" @click="deleteOpen = true">删除</button>
    </div></div>
    <AppState v-if="error" :error="error" @retry="refresh()" />
    <AppState v-else-if="!data" :loading="pending" />
    <AppState v-else-if="!data.items.length" icon="i-ph-lightning-bold" :title="q || status || groupId ? '没有匹配的账号' : '还没有 Logicc 账号'" :description="q || status || groupId ? '调整筛选条件后再试。' : '导入 __client Cookie、Session JWT 或 logicc2api 的 JSON 导出。'">
      <button v-if="!q && !status && !groupId" class="button primary" @click="importOpen = true">导入账号</button>
    </AppState>
    <div v-else class="table-scroll"><table class="data-table">
      <thead><tr><th class="checkbox-cell"><input type="checkbox" :checked="allSelected" aria-label="全选" @change="toggleAll(($event.target as HTMLInputElement).checked)"></th><th>账号</th><th>凭据</th><th>状态</th><th>调用分组</th><th class="align-right">并发</th><th class="align-right">模型</th><th>最近使用</th><th class="align-right">操作</th></tr></thead>
      <tbody>
        <tr v-for="account in data.items" :key="account.id" :class="{ selected: selected.includes(account.id), 'muted-row': !account.enabled }">
          <td class="checkbox-cell"><input v-model="selected" type="checkbox" :value="account.id" :aria-label="'选择 ' + (account.label || account.sessionHint)"></td>
          <td><strong class="account-name">{{ account.label || account.sessionHint || account.id }}</strong><div class="cell-secondary mono">{{ account.sessionHint }}</div><div v-if="account.note" class="cell-secondary">{{ account.note }}</div></td>
          <td class="small-text">{{ credentialLabel(account) }}</td>
          <td><StatusBadge :status="account.enabled ? account.status : 'disabled'" :label="account.enabled ? undefined : '已停用'" /><div v-if="account.cooldownUntil" class="cell-secondary">冷却至 {{ formatDate(account.cooldownUntil) }}</div><div v-if="account.syncError" class="cell-error" :title="account.syncError">{{ account.syncError }}</div></td>
          <td class="wrap-cell">{{ account.groupNames.join('、') || '—' }}</td>
          <td class="align-right">{{ account.inFlight }} / {{ account.maxConcurrency || '∞' }}</td>
          <td class="align-right">{{ account.models.length }}</td>
          <td><span class="date-text">{{ formatDate(account.lastUsedAt) }}</span></td>
          <td><div class="inline-actions justify-end"><button v-if="account.canSignIn" class="button small" :disabled="busy" title="用邮箱密码立即重新登录" @click="bulk('login', [account.id])">重新登录</button><button class="button small" :disabled="busy" @click="bulk('check', [account.id])">检测</button><button class="button small" :disabled="busy" @click="startEdit(account)">编辑</button></div></td>
        </tr>
      </tbody>
    </table></div>
    <AppPagination v-if="data?.total" v-model:page="page" :page-size="pageSize" :total="data.total" :loading="pending" />
    <div class="table-footnote">凭据加密保存，不会在页面或接口中显示。重新导入同一会话会更新它的凭据；并发 0 表示不限。</div>
  </section>

  <ModuleIntakeDialog v-model="importOpen" module-id="logicc" @imported="refresh()" />

  <AppDialog v-model="editOpen" title="编辑 Logicc 账号" :description="editing?.sessionHint || ''" :close-disabled="busy">
    <form id="logicc-account-form" class="form-stack" @submit.prevent="save">
      <label class="field"><span>名称</span><input v-model="form.label" maxlength="100" :disabled="busy"></label>
      <label class="field"><span>备注</span><textarea v-model="form.note" rows="2" maxlength="2000" :disabled="busy" /></label>
      <label class="field"><span>并发上限</span><input v-model.number="form.maxConcurrency" type="number" min="0" max="1000" step="1" required :disabled="busy"><small>同时处理的请求数，0 表示不限制。</small></label>
      <label class="checkbox-line"><input v-model="form.enabled" type="checkbox" :disabled="busy">参与调度</label>
      <label v-if="editing?.canSignIn" class="checkbox-line"><input v-model="form.autoLogin" type="checkbox" :disabled="busy">会话失效时用邮箱密码自动登录</label>
      <GroupSelector v-model="form.groupIds" :groups="groups?.items || []" :disabled="busy" />
      <p class="small-text muted">要更换凭据，直接重新导入同一会话即可。</p>
    </form>
    <template #footer><button class="button" :disabled="busy" @click="editing = null">取消</button><button form="logicc-account-form" class="button primary" :disabled="busy">保存</button></template>
  </AppDialog>

  <AppDialog v-model="deleteOpen" title="删除账号" :description="`确认删除选中的 ${selected.length} 个 Logicc 账号？`" :close-disabled="busy">
    <p class="muted">只会从本平台移除，不影响 Logicc 网站上的账号。删除后可以重新导入。</p>
    <template #footer><button class="button" :disabled="busy" @click="deleteOpen = false">取消</button><button class="button danger-solid" :disabled="busy" @click="bulk('delete')">确认删除</button></template>
  </AppDialog>
</template>
