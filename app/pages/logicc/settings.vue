<script setup lang="ts">
import { LOGICC_TOKEN_FAMILIES, type LogiccSettings, type LogiccSettingsView, type LogiccTokenFamily } from '#shared/logicc'
useHead({ title: 'Logicc 设置 · CPA Nexus' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<LogiccSettingsView>('/api/logicc/settings')
// Nested settings (usage factors) need a deep copy: edits must not touch the loaded data.
function settingsOf(view: LogiccSettingsView | LogiccSettings): LogiccSettings {
  const { anthropicCountKeySet: _a, geminiCountKeySet: _g, calibrated: _c, ...settings } = view as LogiccSettingsView
  return JSON.parse(JSON.stringify(settings)) as LogiccSettings
}
const form = ref<LogiccSettings | null>(null)
const baseline = ref('')
function reset(value?: LogiccSettings | LogiccSettingsView) {
  const source = value ?? data.value
  if (!source) return
  form.value = settingsOf(source)
  baseline.value = JSON.stringify(form.value)
}
watch(data, value => { if (value && (!form.value || JSON.stringify(form.value) === baseline.value)) reset(value) }, { immediate: true })
const dirty = computed(() => !!form.value && JSON.stringify(form.value) !== baseline.value)
const anthropicKey = ref('')
const geminiKey = ref('')
const secretsDirty = computed(() => !!anthropicKey.value.trim() || !!geminiKey.value.trim())
const { busy, run } = useApiAction()
const FAMILY_LABELS: Record<LogiccTokenFamily, string> = { openai: 'GPT / OpenAI', claude: 'Claude', gemini: 'Gemini', other: '其他模型' }
async function save(clear?: 'anthropicCountKey' | 'geminiCountKey') {
  if (!form.value) return
  const secrets: Record<string, string | null> = {}
  if (anthropicKey.value.trim()) secrets.anthropicCountKey = anthropicKey.value.trim()
  if (geminiKey.value.trim()) secrets.geminiCountKey = geminiKey.value.trim()
  if (clear) secrets[clear] = null
  const result = await run(() => api<{ settings: LogiccSettings }>('/api/logicc/settings', { method: 'PATCH', body: { settings: { ...form.value }, secrets } }), 'Logicc 设置已保存')
  if (result.ok) { anthropicKey.value = ''; geminiKey.value = ''; reset(result.value.settings); await refresh() }
}
async function resetCalibration() {
  const result = await run(() => api('/api/logicc/calibration', { method: 'DELETE' }), '已清除自动校准')
  if (result.ok) await refresh()
}
function effective(family: LogiccTokenFamily, direction: 'input' | 'output') {
  if (!form.value || !data.value) return '—'
  return Math.max(1, form.value.usage.factors[family][direction], data.value.calibrated[family][direction]).toFixed(2)
}
</script>

<template>
  <AppPageHeader title="Logicc 设置" description="账号同步、调度、工具调用方式和用量计算。">
    <button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />重新读取</button>
    <button v-if="form" form="logicc-settings-form" class="button primary" :disabled="busy || (!dirty && !secretsDirty)">保存设置</button>
  </AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" />
  <AppState v-else-if="!data || !form" :loading="pending" />
  <form v-else id="logicc-settings-form" class="settings-form" @submit.prevent="save()">
    <fieldset :disabled="busy">
      <section class="settings-section">
        <div class="settings-description"><UIcon name="i-ph-arrows-clockwise-bold" /><h2>账号同步</h2><p>后台定期刷新每个会话（保持 Clerk 登录有效）并读取模型目录。</p></div>
        <div class="settings-fields">
          <label class="field"><span>检测间隔 <small>分钟</small></span><input v-model.number="form.syncIntervalMinutes" type="number" min="2" max="1440" required></label>
          <label class="field"><span>新账号并发上限</span><input v-model.number="form.defaultMaxConcurrency" type="number" min="0" max="1000" required><small>导入时未指定并发的账号使用此值，0 表示不限。</small></label>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-description"><UIcon name="i-ph-shuffle-bold" /><h2>调度与工具</h2><p>同一请求在首个字输出前失败时，会换下一个账号；仍失败则交给其他来源。</p></div>
        <div class="settings-fields">
          <label class="field"><span>单次请求最多尝试账号数</span><input v-model.number="form.maxAccountAttempts" type="number" min="1" max="10" required></label>
          <label class="field"><span>客户端工具调用</span><select v-model="form.toolPolicy"><option value="emulate">模拟：把工具写进提示，解析回标准 tool_calls</option><option value="reject">不处理：带工具的请求交给其他来源</option></select><small>Logicc 没有原生 function calling。Claude Code、Codex 这类重度工具客户端建议选“不处理”。</small></label>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-description"><UIcon name="i-ph-calculator-bold" /><h2>用量计算</h2><p>Logicc 不回传 usage。按发给 Logicc 的完整提示（含酒馆预设、拍平的历史、工具说明、内置工具结果）和生成内容计数，规则是只多不少。</p></div>
        <div class="settings-fields">
          <label class="field"><span>每次请求固定输入开销 <small>token</small></span><input v-model.number="form.usage.promptOverheadTokens" type="number" min="0" max="100000" required><small>覆盖 Logicc 自己加在提示外、平台看不到的隐藏指令。</small></label>
          <label class="field"><span>每次请求固定输出开销 <small>token</small></span><input v-model.number="form.usage.completionOverheadTokens" type="number" min="0" max="100000" required></label>
          <div class="field" style="grid-column: 1 / -1"><span>分词倍率（最低 1.00，生效值 = 设置值与自动校准值取大）</span>
            <div class="usage-factor-grid">
              <div v-for="family in LOGICC_TOKEN_FAMILIES" :key="family" class="panel">
                <h3>{{ FAMILY_LABELS[family] }}</h3>
                <label class="field section-gap"><span>输入</span><input v-model.number="form.usage.factors[family].input" type="number" min="1" max="5" step="0.01" required></label>
                <label class="field section-gap"><span>输出</span><input v-model.number="form.usage.factors[family].output" type="number" min="1" max="5" step="0.01" required></label>
                <p class="small-text muted section-gap">生效 {{ effective(family, 'input') }} / {{ effective(family, 'output') }} · 校准样本 {{ data.calibrated[family].samples }}</p>
              </div>
            </div>
            <small>GPT 系列使用 o200k 分词，与官方一致；Claude、Gemini 没有公开的本地分词器，用倍率放大以免少算。</small>
          </div>
          <label class="checkbox-line"><input v-model="form.usage.autoCalibrate" type="checkbox">用官方计数接口自动校准（只会调高倍率）</label>
          <div class="field"><span>校准记录</span><button type="button" class="button" :disabled="busy" @click="resetCalibration">清除自动校准</button></div>
          <label class="field"><span>Anthropic 计数 Key <small>{{ data.anthropicCountKeySet ? '已配置' : '未配置' }}</small></span><input v-model="anthropicKey" type="password" autocomplete="off" placeholder="sk-ant-…（留空不修改）"><small>调用免费的 count_tokens 接口，取官方计数与本地估算中较大的值。<button v-if="data.anthropicCountKeySet" type="button" class="text-link" @click="save('anthropicCountKey')">清除</button></small></label>
          <label class="field"><span>Anthropic 计数模型</span><input v-model="form.usage.anthropicCountModel" required></label>
          <label class="field"><span>Gemini 计数 Key <small>{{ data.geminiCountKeySet ? '已配置' : '未配置' }}</small></span><input v-model="geminiKey" type="password" autocomplete="off" placeholder="AIza…（留空不修改）"><small>调用免费的 countTokens 接口。<button v-if="data.geminiCountKeySet" type="button" class="text-link" @click="save('geminiCountKey')">清除</button></small></label>
          <label class="field"><span>Gemini 计数模型</span><input v-model="form.usage.geminiCountModel" required></label>
        </div>
      </section>
    </fieldset>
    <div class="settings-save-bar"><span>{{ dirty || secretsDirty ? '设置有未保存的修改' : '当前设置已保存' }}</span><div class="inline-actions"><button type="button" class="button" :disabled="busy || !dirty" @click="reset()">还原修改</button><button class="button primary" :disabled="busy || (!dirty && !secretsDirty)">保存设置</button></div></div>
  </form>
</template>
