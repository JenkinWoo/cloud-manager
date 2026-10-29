<template>
  <div class="page cloud-shell-page">
    <div class="page-header"><div><h1>实例救援终端</h1><p>选择实例名称，即可在当前页面连接串口，处理 SSH 或网络故障。</p></div></div>
    <div class="card connection-card">
      <div class="connection-fields">
        <div class="form-group">
          <label for="shell-account">云账户</label>
          <select id="shell-account" v-model="accountId" class="form-control" :disabled="active || loadingAccounts" @change="selectAccount(false)">
            <option value="">{{ loadingAccounts ? '加载账户中…' : '请选择账户' }}</option>
            <option v-for="account in accounts" :key="account.id" :value="account.id">{{ providerName(account.provider) }} / {{ account.name }}</option>
          </select>
        </div>
        <div v-if="selectedAccount?.provider === 'azure'" class="form-group">
          <label for="shell-subscription">Azure 订阅（用于加载实例）</label>
          <select id="shell-subscription" v-model="subscriptionId" class="form-control" :disabled="active || loadingInstances" @change="changeSubscription">
            <option value="" disabled>请选择订阅</option>
            <option v-for="item in subscriptions" :key="item.subscriptionId" :value="item.subscriptionId">{{ item.displayName || item.subscriptionId }}</option>
          </select>
        </div>
        <div class="form-group instance-field">
          <label for="shell-instance">目标实例</label>
          <div class="instance-input">
            <select id="shell-instance" v-model="instanceId" class="form-control" :disabled="active || loadingInstances || !instances.length">
              <option value="" disabled>{{ instancePlaceholder }}</option>
              <option v-for="instance in instances" :key="instance.id" :value="instance.id">{{ instanceLabel(instance) }}</option>
            </select>
            <button class="btn btn-ghost" :disabled="active || !accountId || loadingInstances" @click="refreshInstances">{{ loadingInstances ? '加载中…' : '刷新实例' }}</button>
          </div>
          <small v-if="instanceError" class="shell-error" role="alert">{{ instanceError }}，请刷新重试。</small>
          <small v-else>选择实例后自动填写连接信息，无需输入实例 ID。</small>
        </div>
      </div>
      <p v-if="selectedAccount" class="context-note">{{ selectedAccount.name }} · {{ providerName(selectedAccount.provider) }}<template v-if="selectedInstance?.region || selectedAccount.region"> · {{ selectedInstance?.region || selectedAccount.region }}</template></p>
      <p class="connection-note">{{ serialNote }} 串口不会自动登录操作系统，可能需要系统用户名和密码。不会自动重启实例或修改防火墙。</p>
      <div class="connect-actions">
        <button v-if="!active" class="btn btn-primary" :disabled="!canConnect" @click="connect">连接救援终端</button>
        <button v-else class="btn btn-danger" @click="terminalPanel.disconnect()">断开 / 取消连接</button>
        <button class="btn btn-ghost" :disabled="active || loadingAccounts" @click="loadAccounts">刷新账户</button>
        <router-link v-if="!loadingAccounts && !accounts.length" class="btn btn-ghost" to="/accounts">添加云账户</router-link>
      </div>
      <p v-if="error" class="shell-error" role="alert">{{ error }}</p>
    </div>
    <CloudTerminal ref="terminalPanel" @active="active = $event" />
    <p class="privacy-note">终端输入与输出不保存到系统日志；临时连接凭据仅在服务内存中使用。</p>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { cloudApi, cloudShellApi } from '../api/index.js'
import CloudTerminal from '../components/CloudTerminal.vue'

const route = useRoute()
const accounts = ref([])
const accountId = ref('')
const instanceId = ref(typeof route.query.instanceId === 'string' ? route.query.instanceId : '')
const instances = ref([])
const subscriptions = ref([])
const subscriptionId = ref('')
const loadingAccounts = ref(false)
const loadingInstances = ref(false)
const instanceError = ref('')
const error = ref('')
const active = ref(false)
const terminalPanel = ref(null)
let disposed = false
let instanceGeneration = 0
let instanceAbort
const selectedAccount = computed(() => accounts.value.find(account => account.id === accountId.value))
const selectedInstance = computed(() => instances.value.find(instance => instance.id === instanceId.value))
const canConnect = computed(() => Boolean(selectedAccount.value?.capabilities?.serial && selectedInstance.value &&
  !active.value && !loadingAccounts.value && !loadingInstances.value && !instanceError.value))
const instancePlaceholder = computed(() => {
  if (!accountId.value) return '请先选择云账户'
  if (loadingInstances.value) return '正在加载实例…'
  if (instanceError.value) return '实例加载失败，请刷新重试'
  if (!instances.value.length) return '当前账户或订阅下暂无实例'
  return '请选择实例名称'
})
const serialNote = computed(() => ({
  oracle: '使用 Oracle Console Connection；需要创建与删除控制台连接的权限。',
  aws: '使用 EC2 Serial Console；账户需已启用串口访问，实例类型、运行状态与 IAM 权限需满足 AWS 要求。',
  azure: '使用 Azure Serial Console；需启用启动诊断、配置系统串口，并授予应用相应订阅和串口权限。'
}[selectedAccount.value?.provider] || '串口连接不依赖实例公网 IP、SSH 服务或来宾系统网络。'))
function providerName(provider) { return { aws: 'AWS', azure: 'Azure', oracle: 'Oracle' }[provider] || provider }
function instanceLabel(instance) {
  const name = instance.displayName || instance.name || instance.id
  const address = instance.publicIps?.[0] || instance.privateIps?.[0]
  const duplicate = instances.value.some(item => item.id !== instance.id && (item.displayName || item.name || item.id) === name)
  return [name, address, duplicate ? instance.id : ''].filter(Boolean).join(' · ')
}
function connect() {
  if (canConnect.value) terminalPanel.value?.connect({ accountId: accountId.value, instanceId: selectedInstance.value.id, mode: 'serial' })
}
function changeSubscription() {
  instanceId.value = ''
  return loadInstances()
}
function refreshInstances() {
  return selectedAccount.value?.provider === 'azure' && !subscriptionId.value ? selectAccount(true) : loadInstances()
}

async function loadAccounts() {
  if (active.value || loadingAccounts.value) return
  loadingAccounts.value = true
  error.value = ''
  try {
    const { data } = await cloudShellApi.list()
    if (disposed) return
    accounts.value = data.accounts.filter(account => account.capabilities?.serial)
    const previousAccount = accountId.value || route.query.accountId
    const preferred = accounts.value.find(account => account.id === previousAccount) || accounts.value[0]
    const preserveInstance = preferred?.id === previousAccount
    accountId.value = preferred?.id || ''
    await selectAccount(preserveInstance)
  } catch (err) { if (!disposed) error.value = err.response?.data?.error || '账户加载失败，请重试' }
  finally { loadingAccounts.value = false }
}

async function selectAccount(preserveInstance = false) {
  if (!preserveInstance) instanceId.value = ''
  subscriptions.value = []
  subscriptionId.value = ''
  instances.value = []
  instanceError.value = ''
  const id = ++instanceGeneration
  instanceAbort?.abort()
  instanceAbort = new AbortController()
  loadingInstances.value = true
  try {
    if (!accountId.value) return
    if (selectedAccount.value?.provider === 'azure') {
      const { data } = await cloudApi.listAzureSubscriptions(accountId.value, { signal: instanceAbort.signal })
      if (disposed || id !== instanceGeneration) return
      subscriptions.value = Array.isArray(data) ? data : data.subscriptions || []
      const targetSubscription = instanceId.value.match(/^\/subscriptions\/([^/]+)/i)?.[1]
      subscriptionId.value = subscriptions.value.find(item => item.subscriptionId.toLowerCase() === targetSubscription?.toLowerCase())?.subscriptionId || subscriptions.value[0]?.subscriptionId || ''
    }
    if (!disposed && id === instanceGeneration) await loadInstances()
  } catch (err) { if (!disposed && id === instanceGeneration) instanceError.value = err.response?.data?.error || '订阅加载失败' }
  finally { if (id === instanceGeneration) loadingInstances.value = false }
}

async function loadInstances() {
  if (!accountId.value || active.value) return
  const id = ++instanceGeneration
  instanceAbort?.abort()
  instanceAbort = new AbortController()
  loadingInstances.value = true
  instanceError.value = ''
  instances.value = []
  try {
    if (selectedAccount.value?.provider === 'azure' && !subscriptionId.value) return
    const { data } = await cloudApi.listInstances(accountId.value, subscriptionId.value ? { subscriptionId: subscriptionId.value } : {}, { signal: instanceAbort.signal })
    if (disposed || id !== instanceGeneration) return
    instances.value = Array.isArray(data) ? data : data.instances || []
    const target = instances.value.find(instance => selectedAccount.value?.provider === 'azure'
      ? instance.id.toLowerCase() === instanceId.value.toLowerCase() : instance.id === instanceId.value)
    instanceId.value = target?.id || ''
  } catch (err) { if (!disposed && id === instanceGeneration) instanceError.value = err.response?.data?.error || '实例加载失败' }
  finally { if (id === instanceGeneration) loadingInstances.value = false }
}
onMounted(loadAccounts)
onUnmounted(() => { disposed = true; instanceAbort?.abort() })
</script>

<style scoped>
.cloud-shell-page { max-width: 1600px; }
.connect-actions, .instance-input { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.connection-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.instance-field { grid-column: 1 / -1; }
.connection-fields .form-group { margin-bottom: 0; }
.instance-input .form-control { flex: 1; min-width: 200px; }
.context-note { color: var(--accent); margin-top: 14px; }
.connection-note, small, .privacy-note { color: var(--text-secondary); font-size: 13px; }
.connection-note { margin-top: 10px; line-height: 1.8; }
.connect-actions { margin-top: 18px; }
.shell-error { color: var(--red); margin-top: 12px; overflow-wrap: anywhere; }
.privacy-note { margin-top: 12px; }
@media (max-width: 900px) { .connection-fields { grid-template-columns: 1fr; } }
</style>
