<template>
  <div class="page billing-page">
    <div class="page-header">
      <div><h1>账户账单</h1><p>按账户查看费用、扣费项目和用量明细。</p></div>
      <div class="header-actions">
        <label for="billing-month">月份</label>
        <input id="billing-month" v-model="month" class="form-control" type="month" :max="currentMonth" @change="load()">
        <button class="btn btn-ghost" :disabled="!selectedAccountId || loading" @click="load(true)">{{ loading ? '查询中…' : '刷新' }}</button>
      </div>
    </div>
    <div class="account-selector" aria-label="账单账户">
      <button v-for="account in accounts" :key="account.accountId" type="button"
        :class="['account-chip', { active: selectedAccountId === account.accountId }]"
        :aria-pressed="selectedAccountId === account.accountId" @click="selectAccount(account.accountId)">
        <span class="chip-provider">{{ providerToken(account.provider) }}</span>
        <span>{{ providerLabel(account.provider) }} / {{ account.accountName }}</span>
      </button>
    </div>
    <div v-if="accountsLoading" class="card loading-wrap" role="status">正在加载账户…</div>
    <div v-else-if="accountsError" class="card billing-error" role="alert">
      <p>{{ accountsError }}</p><button class="btn btn-ghost" @click="loadAccounts">重试</button>
    </div>
    <div v-else-if="!selectedAccountId" class="card empty-state">当前没有启用的计算账户。</div>
    <div v-else-if="loading" class="card loading-wrap" role="status"><div class="spinner"></div>正在查询 {{ selectedAccount?.accountName }} 的账单…</div>
    <div v-else-if="error" class="card billing-error" role="alert">
      <p>{{ error }}</p><button class="btn btn-ghost" @click="load(true)">重试当前账户</button>
    </div>
    <template v-else-if="billing">
      <div class="card summary-card">
        <div><span class="summary-label">账户</span><strong>{{ billing.accountName }}</strong></div>
        <div><span class="summary-label">统计月份（UTC）</span><strong>{{ month }}</strong></div>
        <div><span class="summary-label">{{ billing.status === 'partial' ? '已查询部分费用' : '已入账费用' }}</span>
          <strong v-if="billing.status === 'error'">查询失败</strong>
          <template v-else-if="billing.totals?.length"><strong v-for="total in billing.totals" :key="total.currency">{{ money(total.amount, total.currency) }}</strong></template>
          <strong v-else>暂无账单记录</strong>
        </div>
      </div>
      <p class="billing-note">{{ providerNote }} 费用入账可能延迟，已产生费用不一定等于银行卡扣款。</p>
      <p class="billing-note">明细中的日期为云厂商返回的用量日期或计费期间（UTC），不是银行卡扣款日期；不同日期的费用分别列出。</p>
      <p v-if="billing.estimated" class="billing-note">当月费用为预估，结算后可能调整。</p>
      <p v-if="billing.status !== 'ok'" class="card billing-error" role="alert">{{ billing.error || '部分账单未能获取，请重试。' }}</p>
      <template v-if="billing.subscriptions?.length">
        <section v-for="subscription in billing.subscriptions" :key="subscription.subscriptionId" class="card billing-card">
          <div class="section-heading"><div><h2>{{ subscription.subscriptionName }}</h2><small>{{ subscription.subscriptionId }}</small></div>
            <div v-if="subscription.status === 'ok'" class="subscription-totals"><strong v-for="total in subscription.totals" :key="total.currency">{{ money(total.amount, total.currency) }}</strong></div>
          </div>
          <p v-if="subscription.status === 'error'" class="billing-error">{{ subscription.error }}</p>
          <BillingServiceRows v-else :services="subscription.services" />
        </section>
      </template>
      <section v-else-if="billing.status !== 'error'" class="card billing-card">
        <h2>扣费项目与用量</h2><BillingServiceRows :services="billing.services" />
      </section>
      <p class="billing-note">查询时间：{{ dateTime(billing.checkedAt) }} · 自动查询缓存 10 分钟；点击刷新可重新查询。</p>
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { billingApi } from '../api/index.js'
import BillingServiceRows from '../components/BillingServiceRows.vue'
import { money } from '../utils/billing.js'
const currentMonth = new Date().toISOString().slice(0, 7)
const month = ref(currentMonth)
const accounts = ref([])
const selectedAccountId = ref('')
const selectedAccount = computed(() => accounts.value.find(item => item.accountId === selectedAccountId.value))
const billing = ref(null)
const loading = ref(false)
const accountsLoading = ref(true)
const accountsError = ref('')
const error = ref('')
let controller
let listController
let requestSerial = 0
let disposed = false
const providerNote = computed(() => ({
  azure: 'Azure 按资源和计量项列出实际费用，学生额度抵扣需以 Azure 账单为准。',
  oracle: 'Oracle 按租户查看服务、SKU 和资源用量。',
  aws: 'AWS 按服务和用量类型查看非混合成本；管理账户可能包含组织费用。Cost Explorer 查询可能产生 API 费用。'
})[selectedAccount.value?.provider] || '')
function providerLabel(provider) { return ({ oracle: 'Oracle', aws: 'AWS', azure: 'Azure' })[provider] || provider }
function providerToken(provider) { return ({ oracle: 'O', aws: 'A', azure: 'Az' })[provider] || '?' }
function dateTime(value) { return value ? new Date(value).toLocaleString('zh-CN') : '未知' }
function failureText(failure) {
  if (failure.response?.data?.error) return failure.response.data.error
  if (failure.code === 'ECONNABORTED') return '账单查询超时，请重试当前账户。'
  if (failure.message === 'Network Error' || failure.code === 'ERR_NETWORK') return '无法连接账单服务，请检查后端是否运行或网络连接后重试。'
  return failure.message || '账单查询失败'
}
async function loadAccounts() {
  listController?.abort()
  listController = new AbortController()
  accountsLoading.value = true
  accountsError.value = ''
  try {
    const response = await billingApi.listAccounts({ signal: listController.signal, timeout: 15000 })
    if (disposed) return
    if (!Array.isArray(response.data.accounts)) throw new Error('账户接口未返回有效数据')
    accounts.value = response.data.accounts
    selectedAccountId.value = accounts.value[0]?.accountId || ''
    if (selectedAccountId.value) load()
  } catch (failure) { if (!disposed && failure.code !== 'ERR_CANCELED') accountsError.value = failureText(failure) }
  finally { if (!disposed) accountsLoading.value = false }
}
async function load(refresh = false) {
  controller?.abort()
  const serial = ++requestSerial
  billing.value = null
  error.value = ''
  if (!selectedAccountId.value) return
  if (!/^\d{4}-\d{2}$/.test(month.value) || month.value > currentMonth) { error.value = '请选择有效月份，不能查询未来月份。'; loading.value = false; return }
  controller = new AbortController()
  loading.value = true
  try {
    const response = await billingApi.get(selectedAccountId.value, { month: month.value, ...(refresh ? { refresh: true } : {}) }, { signal: controller.signal, timeout: 180000 })
    if (disposed || serial !== requestSerial) return
    if (response.data.account?.accountId !== selectedAccountId.value) throw new Error('账单接口返回的账户不匹配')
    billing.value = response.data.account
  } catch (failure) {
    if (!disposed && serial === requestSerial && failure.code !== 'ERR_CANCELED') error.value = failureText(failure)
  } finally { if (!disposed && serial === requestSerial) loading.value = false }
}
function selectAccount(id) {
  if (id === selectedAccountId.value && (billing.value || loading.value)) return
  selectedAccountId.value = id
  load()
}
onMounted(loadAccounts)
onBeforeUnmount(() => { disposed = true; requestSerial++; controller?.abort(); listController?.abort() })
</script>

<style scoped>
.page-header { gap: 16px; flex-wrap: wrap; }
.header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.header-actions label { color: var(--text-secondary); font-size: 12px; }
.header-actions input { width: 160px; color-scheme: dark; }
.account-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; overflow-wrap: anywhere; }
.chip-provider { font-family: Consolas, monospace; font-size: 11px; opacity: .8; }
.loading-wrap { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 140px; }
.summary-card { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 16px; }
.summary-card > div, .subscription-totals { display: flex; flex-direction: column; gap: 6px; }
.summary-label, small, .billing-note { color: var(--text-secondary); font-size: 12px; }
.billing-note { margin: 12px 0; }
.billing-card { margin: 16px 0; min-width: 0; }
.billing-card h2 { font-size: 16px; margin-bottom: 8px; }
.section-heading { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.section-heading small { overflow-wrap: anywhere; }
.billing-error { color: var(--red); margin-bottom: 16px; overflow-wrap: anywhere; }
.billing-error button { margin-top: 12px; }
@media(max-width: 720px) { .header-actions { width: 100%; } .summary-card { grid-template-columns: 1fr; } }
</style>
