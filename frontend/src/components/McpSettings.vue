<template>
  <section class="card mcp-settings" aria-labelledby="mcp-title">
    <h3 id="mcp-title">远程 MCP · AI 接入</h3>
    <p class="hint">让支持 MCP 的 AI 查询账户、实例、账单、任务和 DNS。默认只读，可另建允许操作资源的令牌。</p>
    <p v-if="loading" role="status">正在加载 MCP 配置…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button v-if="!loaded && !loading" class="btn" @click="load">重新加载</button>
    <template v-if="loaded">
      <form @submit.prevent="save">
        <label class="toggle"><input v-model="enabled" type="checkbox" :disabled="!!busy" /> 启用远程 MCP</label>
        <div class="form-group">
          <label for="mcp-endpoint">连接地址 · Streamable HTTP</label>
          <div class="inline"><input id="mcp-endpoint" class="form-control" :value="endpoint" readonly /><button type="button" class="btn" @click="copy(endpoint)">复制地址</button></div>
        </div>
        <details>
          <summary>浏览器客户端来源（可选）</summary>
          <p class="hint">桌面 AI 通常无需填写。浏览器客户端填写其来源地址，每行一个，例如 https://ai.example.com。</p>
          <label class="sr-label" for="mcp-origins">允许的浏览器来源</label>
          <textarea id="mcp-origins" v-model="origins" class="form-control" rows="3" :disabled="!!busy" placeholder="https://ai.example.com" />
        </details>
        <button class="btn btn-primary" :disabled="!!busy">{{ busy === 'save' ? '保存中…' : '保存 MCP 设置' }}</button>
        <p class="hint">当前服务：{{ savedEnabled ? '已启用' : '未启用' }}。关闭后所有令牌立即停止接受新请求。</p>
      </form>

      <h4>访问令牌</h4>
      <p class="hint">令牌适用于所有已启用的账户。允许操作的令牌可创建、启停、删除实例及修改 DNS，操作可能产生费用。</p>
      <form class="token-form" @submit.prevent="create">
        <div class="form-group"><label for="mcp-name">用途名称</label><input id="mcp-name" v-model.trim="name" class="form-control" required maxlength="80" placeholder="例如：我的 AI 助手" :disabled="!!busy" /></div>
        <div class="form-group"><label for="mcp-mode">权限</label><select id="mcp-mode" v-model="mode" class="form-control" :disabled="!!busy"><option value="read">只读（默认）</option><option value="write">允许操作资源</option></select></div>
        <div class="form-group"><label for="mcp-days">有效天数</label><input id="mcp-days" v-model.number="days" class="form-control" type="number" min="1" max="365" required :disabled="!!busy" /></div>
        <button class="btn btn-primary" :disabled="busy || !!newToken">{{ busy === 'create' ? '生成中…' : '生成令牌' }}</button>
      </form>
      <div v-if="newToken" class="token-result" role="status">
        <strong>请保存新令牌，关闭后无法再次查看。</strong>
        <textarea class="form-control" :value="newToken.token" readonly rows="2" aria-label="新访问令牌" spellcheck="false" />
        <div class="inline"><button class="btn" @click="copy(newToken.token)">复制令牌</button><button class="btn" @click="copy(clientConfig)">复制客户端配置</button><button class="btn" @click="newToken = null">已保存，关闭</button></div>
        <p class="hint">客户端设置：地址填上方连接地址，Authorization 请求头填 Bearer 加空格和此令牌。复制的配置含令牌，请妥善保存。</p>
      </div>
      <p v-if="!tokens.length" class="hint">还没有访问令牌。</p>
      <ul v-else class="token-list">
        <li v-for="token in tokens" :key="token.id">
          <div><strong>{{ token.name }}</strong><span> · {{ token.mode === 'write' ? '允许操作' : '只读' }} · {{ token.expired ? '已过期' : '有效' }}</span><small>到期：{{ formatDate(token.expiresAt) }}</small></div>
          <button class="btn" :disabled="!!busy" @click="revoke(token)">{{ busy === token.id ? '撤销中…' : '撤销' }}</button>
        </li>
      </ul>
      <p v-if="notice" role="status" class="hint">{{ notice }}</p>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { mcpSettingsApi } from '../api/index.js'

const loading = ref(false), loaded = ref(false), busy = ref(''), error = ref(''), notice = ref('')
const enabled = ref(false), savedEnabled = ref(false), origins = ref(''), tokens = ref([])
const name = ref(''), mode = ref('read'), days = ref(90), newToken = ref(null)
const endpoint = new URL('/mcp', window.location.origin).href
const clientConfig = computed(() => JSON.stringify({ mcpServers: { 'cloud-manager': {
  url: endpoint, headers: { Authorization: `Bearer ${newToken.value?.token || '<YOUR_TOKEN>'}` }
} } }, null, 2))
const formatDate = value => new Date(value).toLocaleString()
const showError = cause => { error.value = cause.response?.data?.error || cause.message || '请求失败，请重试' }
function setConfig(data) {
  enabled.value = data.enabled
  savedEnabled.value = data.enabled
  origins.value = data.allowedOrigins.join('\n')
  tokens.value = data.tokens
}
async function load() {
  loading.value = true; error.value = ''
  try { setConfig((await mcpSettingsApi.get()).data); loaded.value = true }
  catch (cause) { showError(cause) }
  finally { loading.value = false }
}
async function perform(key, action) {
  busy.value = key; error.value = ''; notice.value = ''
  try { await action() } catch (cause) { showError(cause) } finally { busy.value = '' }
}
const save = () => perform('save', async () => {
  setConfig((await mcpSettingsApi.save({ enabled: enabled.value, allowedOrigins: origins.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) })).data)
  notice.value = 'MCP 设置已保存'
})
const create = () => perform('create', async () => {
  const data = (await mcpSettingsApi.createToken({ name: name.value, mode: mode.value, expiresInDays: days.value })).data
  newToken.value = data
  tokens.value = [...tokens.value.filter(t => !t.expired), { id: data.id, name: data.name, mode: data.mode, expiresAt: data.expiresAt, expired: false }]
  name.value = ''
})
const revoke = token => perform(token.id, async () => {
  await mcpSettingsApi.revokeToken(token.id)
  tokens.value = tokens.value.filter(t => t.id !== token.id)
  if (newToken.value?.id === token.id) newToken.value = null
  notice.value = '令牌已撤销，后续请求将被拒绝'
})
async function copy(value) {
  try { await navigator.clipboard.writeText(value); notice.value = '已复制' }
  catch { error.value = '自动复制失败，请手动选择并复制；HTTPS 环境支持自动复制。' }
}
onMounted(load)
</script>

<style scoped>
.mcp-settings { margin-bottom: 16px; }
h3 { font-size: 15px; margin-bottom: 12px; }
h4 { margin: 22px 0 10px; }
.hint, small { color: var(--text-secondary); font-size: 12px; line-height: 1.7; margin: 10px 0; }
.toggle { display: flex; align-items: center; gap: 8px; margin: 16px 0; }
.inline { display: flex; gap: 8px; flex-wrap: wrap; }
.inline .form-control { flex: 1; min-width: 180px; }
details { margin-bottom: 14px; }
summary { cursor: pointer; font-size: 13px; }
.token-form { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }
.token-form .form-group { flex: 1; min-width: 130px; margin-bottom: 0; }
.token-result { margin-top: 16px; padding: 14px; border: 1px solid var(--border-color, #888); border-radius: 8px; }
.token-result textarea { margin: 10px 0; word-break: break-all; }
.token-list { list-style: none; padding: 0; margin: 16px 0 0; }
.token-list li { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border-color, #888); font-size: 13px; overflow-wrap: anywhere; }
small { display: block; margin: 2px 0; }
.error { color: var(--danger, #dc2626); }
.sr-label { display: block; margin-bottom: 6px; font-size: 12px; }
</style>
