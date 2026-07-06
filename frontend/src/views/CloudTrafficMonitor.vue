<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>云流量统计</h1>
        <p>按自然月统计云机器入站和出站流量量。</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" :disabled="!selectedAccountId || loadingUsage" @click="loadUsage">
          {{ loadingUsage ? '同步中...' : '刷新' }}
        </button>
      </div>
    </div>

    <div class="account-selector">
      <span v-if="loadingAccounts" class="muted-text">加载计算账户中...</span>
      <template v-else-if="accounts.length">
        <button v-for="account in accounts" :key="account.id" type="button"
          :class="['account-chip', selectedAccountId === account.id ? 'active' : '']"
          @click="selectAccount(account.id)">
          <span class="chip-provider">{{ providerToken(account.computeProvider) }}</span>
          <span>{{ providerLabel(account.computeProvider) }} / {{ account.name }}</span>
        </button>
      </template>
      <span v-else class="muted-text">当前还没有计算账户</span>
    </div>

    <div v-if="selectedAccount?.computeProvider === 'azure'" class="card filter-card">
      <div class="form-group">
        <label>Azure 订阅</label>
        <select v-model="azureSubscriptionId" class="form-control" :disabled="loadingAzureSubscriptions"
          @change="handleAzureSubscriptionChange">
          <option value="">
            {{ loadingAzureSubscriptions ? '正在加载订阅...' : '使用默认可用订阅' }}
          </option>
          <option v-for="subscription in azureSubscriptions" :key="subscription.subscriptionId"
            :value="subscription.subscriptionId">
            {{ subscription.displayName }} / {{ subscription.subscriptionId }}
          </option>
        </select>
      </div>
    </div>

    <div v-if="!selectedAccountId" class="card empty-state">
      <div class="empty-icon">!</div>
      <p>请选择一个计算账户。</p>
    </div>

    <template v-else>
      <div v-if="loadingUsage" class="card loading-wrap">
        <div class="spinner"></div>
      </div>

      <template v-else>
        <div class="summary-grid">
          <div class="summary-card">
            <span class="summary-label">统计周期</span>
            <strong>{{ periodLabel }}</strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">入站流量</span>
            <strong>{{ formatBytes(usage?.totalInBytes) }}</strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">出站流量</span>
            <strong>{{ formatBytes(usage?.totalOutBytes) }}</strong>
          </div>
          <div class="summary-card">
            <span class="summary-label">机器数量</span>
            <strong>{{ usage?.currentInstanceCount || 0 }} / {{ usage?.deletedInstanceCount || 0 }}</strong>
          </div>
        </div>

        <div v-if="usage?.metricsError" class="notice-card">
          {{ usage.metricsError }}
        </div>
        <div v-else-if="usage?.metricsUnavailableCount" class="notice-card">
          有 {{ usage.metricsUnavailableCount }} 台机器暂未获取到云监控指标，表格中会显示为无数据。
        </div>

        <div class="card">
          <div class="records-head">
            <h3 class="section-heading" style="margin:0">机器流量明细</h3>
            <span class="muted-text">最后同步 {{ formatDate(usage?.periodEnd) }}</span>
          </div>

          <div v-if="usageItems.length === 0" class="empty-text">暂无流量统计</div>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>机器</th>
                  <th>状态</th>
                  <th>地域</th>
                  <th>公网 IP</th>
                  <th>指标</th>
                  <th>入站流量</th>
                  <th>出站流量</th>
                  <th>最后发现</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in usageItems" :key="item.instanceId" :class="{ 'deleted-row': item.deleted }">
                  <td>
                    <div class="instance-name">{{ item.displayName || item.instanceId }}</div>
                    <div class="instance-id">{{ item.instanceId }}</div>
                  </td>
                  <td>
                    <span :class="['badge', item.deleted ? 'badge-stopped' : 'badge-running']">
                      {{ item.deleted ? '已删除' : stateLabel(item.state) }}
                    </span>
                  </td>
                  <td>{{ item.region || '-' }}</td>
                  <td>
                    <div v-if="item.publicIps?.length" class="ip-list">
                      <span v-for="ip in item.publicIps" :key="ip" class="ip-tag">{{ ip }}</span>
                    </div>
                    <span v-else>-</span>
                  </td>
                  <td>
                    <span :class="['badge', item.metricStatus === 'ok' ? 'badge-running' : 'badge-stopped']">
                      {{ item.metricStatus === 'ok' ? '正常' : '无数据' }}
                    </span>
                  </td>
                  <td>{{ formatBytes(item.networkInBytesMonth) }}</td>
                  <td>{{ formatBytes(item.networkOutBytesMonth) }}</td>
                  <td>{{ formatDate(item.lastSeenAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { accountsApi, cloudApi } from '../api/index.js'

const accounts = ref([])
const selectedAccountId = ref('')
const loadingAccounts = ref(true)
const loadingUsage = ref(false)
const usage = ref(null)

const azureSubscriptions = ref([])
const azureSubscriptionId = ref('')
const loadingAzureSubscriptions = ref(false)

let usageController = null
let usageRequestId = 0
let azureSubscriptionsController = null
let azureSubscriptionsRequestId = 0

const selectedAccount = computed(() => accounts.value.find((item) => item.id === selectedAccountId.value) || null)
const usageItems = computed(() => usage.value?.items || [])
const periodLabel = computed(() => {
  if (!usage.value?.periodStart || !usage.value?.periodEnd) return '-'
  return `${formatDate(usage.value.periodStart, false)} 至 ${formatDate(usage.value.periodEnd, false)}`
})

onMounted(async () => {
  await loadAccounts()
})

onBeforeUnmount(() => {
  abortUsageRequest()
  abortAzureSubscriptionsRequest()
})

async function loadAccounts() {
  loadingAccounts.value = true
  try {
    const response = await accountsApi.list()
    accounts.value = (response.data || []).filter((item) => item.computeProvider && item.enabled !== false)
    if (accounts.value.length) {
      await selectAccount(accounts.value[0].id)
    }
  } catch (error) {
    toast(error.response?.data?.error || error.message, 'error')
  } finally {
    loadingAccounts.value = false
  }
}

async function selectAccount(accountId) {
  if (selectedAccountId.value === accountId && usage.value) return

  abortUsageRequest()
  abortAzureSubscriptionsRequest()
  selectedAccountId.value = accountId
  usage.value = null
  resetAzureState()

  if (selectedAccount.value?.computeProvider === 'azure') {
    await loadAzureSubscriptions(accountId)
  }

  if (selectedAccountId.value === accountId) {
    await loadUsage()
  }
}

function resetAzureState() {
  azureSubscriptions.value = []
  azureSubscriptionId.value = ''
}

function getAzureSubscriptionStorageKey(accountId = selectedAccountId.value) {
  return `cloud-manager:traffic-monitor:azure-subscription:${accountId}`
}

async function loadAzureSubscriptions(accountId = selectedAccountId.value) {
  if (!accountId) return

  const requestId = ++azureSubscriptionsRequestId
  abortController(azureSubscriptionsController)
  const controller = new AbortController()
  azureSubscriptionsController = controller
  loadingAzureSubscriptions.value = true

  try {
    const response = await cloudApi.listAzureSubscriptions(accountId, { signal: controller.signal })
    if (controller.signal.aborted || requestId !== azureSubscriptionsRequestId || selectedAccountId.value !== accountId) return

    azureSubscriptions.value = response.data || []
    const savedSubscriptionId = localStorage.getItem(getAzureSubscriptionStorageKey(accountId)) || ''
    const selected =
      azureSubscriptions.value.find((item) => item.subscriptionId === savedSubscriptionId) || azureSubscriptions.value[0] || null
    azureSubscriptionId.value = selected?.subscriptionId || ''
  } catch (error) {
    if (!isAbortError(error)) toast(error.response?.data?.error || error.message, 'error')
  } finally {
    if (requestId === azureSubscriptionsRequestId && azureSubscriptionsController === controller) {
      loadingAzureSubscriptions.value = false
      azureSubscriptionsController = null
    }
  }
}

async function handleAzureSubscriptionChange() {
  localStorage.setItem(getAzureSubscriptionStorageKey(), azureSubscriptionId.value)
  await loadUsage()
}

function getRequestParams() {
  if (selectedAccount.value?.computeProvider === 'azure' && azureSubscriptionId.value) {
    return { subscriptionId: azureSubscriptionId.value }
  }
  return {}
}

async function loadUsage() {
  const accountId = selectedAccountId.value
  if (!accountId) return

  const requestId = ++usageRequestId
  abortController(usageController)
  const controller = new AbortController()
  usageController = controller
  loadingUsage.value = true

  try {
    const response = await cloudApi.trafficUsage(accountId, getRequestParams(), { signal: controller.signal })
    if (controller.signal.aborted || requestId !== usageRequestId || selectedAccountId.value !== accountId) return
    usage.value = response.data
  } catch (error) {
    if (!isAbortError(error)) toast(error.response?.data?.error || error.message, 'error')
  } finally {
    if (requestId === usageRequestId && usageController === controller) {
      loadingUsage.value = false
      usageController = null
    }
  }
}

function abortController(controller) {
  if (controller && !controller.signal.aborted) controller.abort()
}

function abortUsageRequest() {
  usageRequestId += 1
  abortController(usageController)
  usageController = null
  loadingUsage.value = false
}

function abortAzureSubscriptionsRequest() {
  azureSubscriptionsRequestId += 1
  abortController(azureSubscriptionsController)
  azureSubscriptionsController = null
  loadingAzureSubscriptions.value = false
}

function isAbortError(error) {
  return error?.code === 'ERR_CANCELED' || error?.name === 'AbortError' || error?.name === 'CanceledError'
}

function providerLabel(provider) {
  if (provider === 'oracle') return 'Oracle'
  if (provider === 'aws') return 'AWS'
  if (provider === 'azure') return 'Azure'
  return provider || '-'
}

function providerToken(provider) {
  if (provider === 'oracle') return 'OCI'
  if (provider === 'aws') return 'AWS'
  if (provider === 'azure') return 'AZ'
  return '--'
}

function stateLabel(state) {
  const current = String(state || '').toUpperCase()
  const labels = {
    RUNNING: '运行中',
    STOPPED: '已停止',
    STOPPING: '停止中',
    STARTING: '启动中',
    PROVISIONING: '创建中',
    TERMINATED: '已终止',
    DELETED: '已删除',
    UNKNOWN: '未知'
  }
  return labels[current] || current || '未知'
}

function formatBytes(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  if (numeric <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let size = numeric
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(digits)} ${units[unitIndex]}`
}

function formatDate(value, withTime = true) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
  })
}

function toast(message, type = 'info') {
  window.$toast?.(message, type)
}
</script>

<style scoped>
.header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.chip-provider {
  font-family: Consolas, monospace;
  font-size: 11px;
  opacity: 0.8;
}

.muted-text,
.empty-text {
  color: var(--text-muted);
  font-size: 13px;
}

.filter-card {
  margin-bottom: 20px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
  margin-bottom: 20px;
}

.summary-card {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
}

.summary-label {
  display: block;
  color: var(--text-muted);
  font-size: 12px;
  margin-bottom: 8px;
}

.summary-card strong {
  font-size: 20px;
  font-weight: 700;
}

.notice-card {
  margin-bottom: 20px;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.08);
  color: var(--yellow);
  font-size: 13px;
}

.records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.section-heading {
  font-size: 14px;
  font-weight: 600;
}

.loading-wrap {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 160px;
}

.instance-name {
  font-weight: 600;
}

.instance-id {
  margin-top: 4px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-family: Consolas, monospace;
  font-size: 12px;
}

.ip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ip-tag {
  display: inline-flex;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 12px;
  font-family: Consolas, monospace;
}

.deleted-row {
  opacity: 0.72;
}
</style>
