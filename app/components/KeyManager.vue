<script setup lang="ts">
import type { GatewayKeyView } from '#shared/types'
import type { ModuleView } from '#shared/modules'
import type { KeyPresetBinding } from '#shared/presets'

type KeyKind = 'gateway' | 'service'
type ModelModule = 'cpa' | 'commandcode'
interface ManagedKey extends GatewayKeyView { kind: KeyKind }

const api = useRequestFetch()
const [gateway, service, modules, presetRoutes] = await Promise.all([
  useFetch<{ items: GatewayKeyView[] }>('/api/keys'),
  useFetch<{ items: GatewayKeyView[] }>('/api/service-keys'),
  useFetch<{ modules: ModuleView[] }>('/api/modules', { key: 'nexus-modules' }),
  useFetch<{ bindings: KeyPresetBinding[] }>('/api/presets/routes', { key: 'nexus-preset-routes' }),
])
const commandcodeEnabled = computed(() => modules.data.value?.modules.find(module => module.id === 'commandcode')?.enabled === true)
const presetModuleEnabled = computed(() => modules.data.value?.modules.find(module => module.id === 'presets')?.enabled === true)
const pending = computed(() => gateway.pending.value || service.pending.value || modules.pending.value)
const loaded = computed(() => !!gateway.data.value || !!service.data.value)
const items = computed<ManagedKey[]>(() => [
  ...(gateway.data.value?.items || []).map(key => ({ ...key, kind: 'gateway' as const })),
  ...(service.data.value?.items || []).map(key => ({ ...key, kind: 'service' as const })),
].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const filter = ref<'all' | KeyKind>('all')
const visibleItems = computed(() => items.value.filter(key => filter.value === 'all' || key.kind === filter.value))
async function refreshKeys() { await Promise.all([gateway.refresh(), service.refresh(), presetRoutes.refresh()]) }
async function refresh() { await Promise.all([refreshKeys(), modules.refresh()]) }
useLiveRefresh(refreshKeys)

const createOpen = ref(false)
const createKind = ref<KeyKind>('gateway')
const keyName = ref('')
const moduleId = ref<ModelModule>('cpa')
const createPresetEnabled = ref(false)
const canCreate = computed(() => !!keyName.value.trim() && !modules.pending.value && !modules.error.value && (createKind.value === 'service' ? commandcodeEnabled.value : moduleId.value === 'cpa' || commandcodeEnabled.value))
watch(commandcodeEnabled, enabled => {
  if (!enabled) {
    createKind.value = 'gateway'
    moduleId.value = 'cpa'
  }
})
const editTarget = ref<ManagedKey | null>(null)
const editName = ref('')
const editModule = ref<ModelModule>('cpa')
const editPresetEnabled = ref(false)
const editOpen = computed({ get: () => !!editTarget.value, set: value => { if (!value) editTarget.value = null } })
const canEdit = computed(() => !!editName.value.trim() && (editTarget.value?.kind === 'service' || (!!presetRoutes.data.value && !presetRoutes.error.value && (editModule.value === boundModule(editTarget.value) || editModule.value === 'cpa' || commandcodeEnabled.value))))
const createdKey = ref('')
const createdKind = ref<KeyKind>('gateway')
const createdModule = ref<ModelModule>('cpa')
const createdPresetEnabled = ref(false)
const secretOpen = computed({ get: () => !!createdKey.value, set: value => { if (!value) createdKey.value = '' } })
const revokeTarget = ref<ManagedKey | null>(null)
const revokeOpen = computed({ get: () => !!revokeTarget.value, set: value => { if (!value) revokeTarget.value = null } })
const { busy, run } = useApiAction()
const toast = useToast()

function endpoint(kind: KeyKind) { return kind === 'service' ? '/api/service-keys' : '/api/keys' }
function kindLabel(kind: KeyKind) { return kind === 'service' ? '外调服务 API Key' : '模型 API Key' }
function boundModule(key: ManagedKey | null): ModelModule { return key?.kind === 'service' ? 'commandcode' : key?.moduleId || 'commandcode' }
function moduleLabel(value: ModelModule) { return value === 'cpa' ? 'CPA 核心' : 'Command Code' }
function moduleDisabled(key: ManagedKey) { return boundModule(key) === 'commandcode' && modules.data.value?.modules.find(module => module.id === 'commandcode')?.enabled === false }
function usesPresets(key: ManagedKey) {
  if (key.kind === 'service') return false
  const binding = presetRoutes.data.value?.bindings.find(item => item.keyId === key.id)
  return binding?.mode === 'stack' || binding?.mode === 'preset'
}
function startCreate() {
  keyName.value = ''
  createKind.value = 'gateway'
  moduleId.value = 'cpa'
  createPresetEnabled.value = false
  createOpen.value = true
}
async function createKey() {
  if (!canCreate.value) return
  const kind = createKind.value
  const binding = moduleId.value
  const usePresets = createPresetEnabled.value
  const result = await run(() => api<{ key: string; item: GatewayKeyView }>(endpoint(kind), {
    method: 'POST', body: { name: keyName.value.trim(), ...(kind === 'gateway' ? { moduleId: binding, presetEnabled: usePresets } : {}) },
  }))
  if (result.ok) {
    createOpen.value = false
    createdKind.value = kind
    createdModule.value = binding
    createdPresetEnabled.value = kind === 'gateway' && usePresets
    createdKey.value = result.value.key
    await refreshKeys()
  }
}
function startEdit(key: ManagedKey) {
  editName.value = key.name
  editModule.value = boundModule(key)
  editPresetEnabled.value = usesPresets(key)
  editTarget.value = key
}
async function saveKey() {
  const target = editTarget.value
  if (!target || !canEdit.value) return
  const result = await run(() => api(endpoint(target.kind) + '/' + target.id, {
    method: 'PATCH', body: {
      name: editName.value.trim(),
      ...(target.kind === 'gateway' && editModule.value !== boundModule(target) ? { moduleId: editModule.value } : {}),
      ...(target.kind === 'gateway' ? { presetEnabled: editPresetEnabled.value } : {}),
    },
  }), '密钥设置已保存')
  if (result.ok) { editTarget.value = null; await refreshKeys() }
}
async function toggle(key: ManagedKey) {
  if (!key.enabled && moduleDisabled(key)) return
  const result = await run(() => api(endpoint(key.kind) + '/' + key.id, {
    method: 'PATCH', body: { enabled: !key.enabled },
  }), key.enabled ? '密钥已停用' : '密钥已启用')
  if (result.ok) await refreshKeys()
}
async function revoke() {
  const target = revokeTarget.value
  if (!target) return
  const result = await run(() => api(endpoint(target.kind) + '/' + target.id, { method: 'DELETE' }), '密钥已撤销')
  if (result.ok) { revokeTarget.value = null; await refreshKeys() }
}
async function copyKey() {
  try {
    await navigator.clipboard.writeText(createdKey.value)
    toast.add({ title: '密钥已复制', icon: 'i-ph-check-bold' })
  } catch {
    toast.add({ title: '无法访问剪贴板，请手动复制密钥', color: 'error', icon: 'i-ph-warning-bold' })
  }
}
</script>

<template>
  <section class="table-panel">
    <div class="table-toolbar">
      <div><h2>调用密钥</h2><p class="small-text muted">模型密钥可选择普通调用或经过酒馆模块；外调服务密钥用于 Command Code 账号导入与状态查询。</p></div>
      <div class="inline-actions toolbar-meta">
        <select v-model="filter" aria-label="按密钥类型筛选"><option value="all">全部类型</option><option value="gateway">模型 API Key</option><option v-if="commandcodeEnabled || items.some(key => key.kind === 'service')" value="service">外调服务 API Key</option></select>
        <button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新</button>
        <button class="button primary" :disabled="busy || modules.pending.value || !!modules.error.value" @click="startCreate"><UIcon name="i-ph-plus-bold" />创建 API Key</button>
      </div>
    </div>
    <AppState v-if="modules.error.value" :error="modules.error.value" compact title="无法读取模块状态" @retry="modules.refresh()" />
    <AppState v-if="gateway.error.value" :error="gateway.error.value" compact title="模型密钥读取失败" @retry="gateway.refresh()" />
    <AppState v-if="service.error.value" :error="service.error.value" compact title="外调服务密钥读取失败" @retry="service.refresh()" />
    <AppState v-if="presetRoutes.error.value" :error="presetRoutes.error.value" compact title="酒馆路由读取失败" @retry="presetRoutes.refresh()" />
    <AppState v-if="!loaded && pending" loading />
    <AppState v-else-if="loaded && !visibleItems.length" icon="i-ph-key-bold" :title="filter === 'all' ? '还没有 API Key' : '没有此类型的密钥'" description="创建模型 API Key 并选择绑定模块，即可配置到模型客户端。">
      <button class="button primary" :disabled="busy || modules.pending.value || !!modules.error.value" @click="startCreate">创建 API Key</button>
    </AppState>
    <div v-else-if="visibleItems.length" class="table-scroll">
      <table class="data-table">
        <thead><tr><th>名称 / 密钥标识</th><th>类型</th><th>绑定模块</th><th>酒馆模块</th><th>状态</th><th>创建时间</th><th>最近使用</th><th class="align-right">操作</th></tr></thead>
        <tbody>
          <tr v-for="key in visibleItems" :key="key.kind + ':' + key.id">
            <td><strong>{{ key.name }}</strong><div class="cell-secondary mono">{{ key.prefix }}…</div></td>
            <td>{{ kindLabel(key.kind) }}</td>
            <td>{{ moduleLabel(boundModule(key)) }}<div v-if="moduleDisabled(key)" class="cell-error">模块已停用，调用不可用</div></td>
            <td><template v-if="key.kind === 'gateway'"><template v-if="presetRoutes.data.value">{{ usesPresets(key) ? '叠加已开启预设' : '普通调用' }}<div v-if="usesPresets(key) && !presetModuleEnabled" class="cell-secondary">酒馆模块停用，暂时直连</div></template><span v-else class="muted">状态未读取</span></template><span v-else class="muted">—</span></td>
            <td><StatusBadge :status="key.enabled ? 'enabled' : 'disabled'" :label="key.enabled ? '已启用' : '已停用'" /></td>
            <td>{{ formatDate(key.createdAt) }}</td><td>{{ formatDate(key.lastUsedAt) }}</td>
            <td><div class="inline-actions justify-end"><button class="button small" :disabled="busy || (key.kind === 'gateway' && (!presetRoutes.data.value || !!presetRoutes.error.value))" @click="startEdit(key)">编辑</button><button class="button small" :disabled="busy || (!key.enabled && moduleDisabled(key))" @click="toggle(key)">{{ key.enabled ? '停用' : '启用' }}</button><button class="button small danger" :disabled="busy" @click="revokeTarget = key">撤销</button></div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="table-footnote">完整密钥只在创建时显示一次。选择经过酒馆模块的模型 Key，会依次叠加「酒馆预设」中所有已开启的预设。</div>
  </section>

  <AppDialog v-model="createOpen" title="创建 API Key" description="选择密钥类型和绑定模块，名称用于区分客户端或用途。" :close-disabled="busy">
    <form id="create-api-key-form" class="form-stack" @submit.prevent="createKey">
      <label class="field"><span>密钥名称</span><input v-model="keyName" required maxlength="80" placeholder="例如：KA、KB 或日常开发客户端" :disabled="busy" autofocus></label>
      <label class="field"><span>密钥类型</span><select v-model="createKind" :disabled="busy"><option value="gateway">模型 API Key</option><option v-if="commandcodeEnabled" value="service">外调服务 API Key</option></select><small v-if="!commandcodeEnabled">启用 Command Code 模块后，可创建外调服务 API Key。</small></label>
      <template v-if="createKind === 'gateway'">
        <label class="field"><span>绑定模块</span><select v-model="moduleId" :disabled="busy"><option value="cpa">CPA 核心</option><option v-if="commandcodeEnabled" value="commandcode">Command Code</option></select><small>默认绑定 CPA 核心，此密钥调用所选模块的模型。</small></label>
        <label class="field"><span>是否经过酒馆模块</span><select v-model="createPresetEnabled" :disabled="busy"><option :value="false">普通模型调用</option><option :value="true">经过酒馆模块，叠加已开启预设</option></select><small v-if="createPresetEnabled">调用时按酒馆模块中的顺序叠加所有已开启预设，可随时在那里调整开关和顺序。</small></label>
        <p v-if="createPresetEnabled && !presetModuleEnabled" class="small-text muted">酒馆模块目前已停用。可以先保存此选择，启用模块后生效；停用期间正常直连。</p>
      </template>
      <p v-else class="small-text muted">绑定 Command Code，用于外部服务添加账号、查询导入进度和账号池状态。</p>
    </form>
    <template #footer><button class="button" :disabled="busy" @click="createOpen = false">取消</button><button form="create-api-key-form" class="button primary" :disabled="busy || !canCreate">创建密钥</button></template>
  </AppDialog>

  <AppDialog v-model="editOpen" title="编辑 API Key" description="修改名称或绑定模块后，客户端继续使用原有密钥。" :close-disabled="busy">
    <form id="edit-api-key-form" class="form-stack" @submit.prevent="saveKey">
      <label class="field"><span>密钥名称</span><input v-model="editName" required maxlength="80" :disabled="busy"></label>
      <p class="small-text muted">类型：{{ editTarget ? kindLabel(editTarget.kind) : '' }}</p>
      <label v-if="editTarget?.kind === 'gateway'" class="field"><span>绑定模块</span><select v-model="editModule" :disabled="busy"><option value="cpa">CPA 核心</option><option v-if="commandcodeEnabled || editModule === 'commandcode'" value="commandcode" :disabled="!commandcodeEnabled">Command Code{{ commandcodeEnabled ? '' : '（模块已停用）' }}</option></select><small>保存后，此密钥的后续模型请求会使用所选模块。</small></label>
      <p v-else class="small-text muted">外调服务 API Key 固定绑定 Command Code。</p>
      <template v-if="editTarget?.kind === 'gateway'">
        <label class="field"><span>是否经过酒馆模块</span><select v-model="editPresetEnabled" :disabled="busy"><option :value="false">普通模型调用</option><option :value="true">经过酒馆模块，叠加已开启预设</option></select><small>保存后对这个 Key 的后续请求生效，所有已开启预设按酒馆模块中的顺序共同应用。</small></label>
        <p v-if="editPresetEnabled && !presetModuleEnabled" class="small-text muted">酒馆模块目前已停用。此选择会保留，启用模块后生效；停用期间正常直连。</p>
      </template>
    </form>
    <template #footer><button class="button" :disabled="busy" @click="editTarget = null">取消</button><button form="edit-api-key-form" class="button primary" :disabled="busy || !canEdit">保存设置</button></template>
  </AppDialog>

  <AppDialog v-model="secretOpen" :title="'请保存新' + kindLabel(createdKind)" description="完整密钥仅显示这一次。关闭后无法再次查看。">
    <div class="secret-box"><code>{{ createdKey }}</code></div>
    <p v-if="createdKind === 'gateway'" class="small-text muted">已绑定 {{ moduleLabel(createdModule) }}。将此密钥填入模型客户端的 API Key 设置，Base URL 使用你的域名加 /v1。</p>
    <p v-if="createdKind === 'gateway' && createdPresetEnabled" class="small-text muted">已选择经过酒馆模块，模块开启时叠加全部已开启预设。</p>
    <p v-else class="small-text muted">将此密钥配置到外部服务，通过 Authorization: Bearer 或 x-api-key 请求 /api/external/*。</p>
    <template #footer><button class="button" @click="secretOpen = false">已保存，关闭</button><button class="button primary" @click="copyKey"><UIcon name="i-ph-copy-bold" />复制密钥</button></template>
  </AppDialog>

  <AppDialog v-model="revokeOpen" title="撤销 API Key" :description="'确认撤销「' + (revokeTarget?.name || '') + '」？使用此密钥的' + (revokeTarget?.kind === 'service' ? '外部服务将无法继续添加账号或查询状态。' : '客户端将无法继续调用模型。')" :close-disabled="busy">
    <p class="muted">此操作不能撤销。如只需暂时关闭访问，可以选择停用。</p>
    <template #footer><button class="button" :disabled="busy" @click="revokeTarget = null">取消</button><button class="button danger-solid" :disabled="busy" @click="revoke">确认撤销</button></template>
  </AppDialog>
</template>
