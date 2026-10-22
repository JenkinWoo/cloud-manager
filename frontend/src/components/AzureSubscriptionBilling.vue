<template>
  <section class="azure-billing" aria-label="Azure 订阅费用和学生额度">
    <div class="billing-header">
      <h3>订阅费用与学生额度</h3>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="loading" @click="load">刷新</button>
    </div>
    <p v-if="loading" class="form-hint">正在查询 Azure 费用和额度…</p>
    <p v-else-if="error" class="form-hint error-text">{{ error }}</p>
    <template v-else-if="billing">
      <div class="billing-grid">
        <div class="billing-item">
          <span class="billing-label">本月已产生费用</span>
          <strong>{{ money(billing.currentMonth?.amount, billing.currentMonth?.currency) }}</strong>
        </div>
        <div class="billing-item">
          <span class="billing-label">学生积分 / 额度</span>
          <strong>{{ money(billing.credit?.amount, billing.credit?.currency) }}</strong>
        </div>
        <div class="billing-item">
          <span class="billing-label">权益期累计费用</span>
          <strong>{{ money(billing.credit?.used?.amount, billing.credit?.used?.currency) }}</strong>
        </div>
        <div class="billing-item">
          <span class="billing-label">参考剩余额度</span>
          <strong>{{ money(billing.credit?.referenceRemaining, billing.credit?.currency) }}</strong>
        </div>
      </div>
      <p class="form-hint">
        有效期：{{ date(billing.credit?.startDate) }} 至 {{ date(billing.credit?.endDate) }}
        · 额度状态：{{ billing.credit?.status || '未知' }}
      </p>
      <p class="form-hint">数据检查时间：{{ dateTime(billing.checkedAt) }}</p>
      <p class="form-hint billing-status">
        订阅计费状态：{{ billing.billingStatus || '未知' }} · 付款类型：{{ billing.subscriptionBillingType || '未知' }}
      </p>
      <p v-if="billing.officialBalance" class="form-hint">Azure 官方余额：{{ money(billing.officialBalance.value, billing.officialBalance.currency) }}</p>
      <details v-if="billing.currentMonth?.rows?.length">
        <summary>查看本月收费服务</summary>
        <p v-for="row in billing.currentMonth.rows" :key="`${row.ServiceName}-${row.Currency}`" class="form-hint">
          {{ row.ServiceName || '未知服务' }}：{{ money(Number(row.PreTaxCost), row.Currency) }}
        </p>
      </details>
    </template>
  </section>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { cloudApi } from '../api/index.js'

const props = defineProps({
  accountId: { type: String, required: true },
  subscriptionId: { type: String, required: true }
})
const billing = ref(null)
const loading = ref(false)
const error = ref('')
let controller = null
let requestId = 0

function money(value, currency = 'USD') {
  if (!Number.isFinite(Number(value))) return '暂无数据'
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))
}

function date(value) {
  if (!value) return '未知'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '未知' : parsed.toLocaleDateString('zh-CN')
}

function dateTime(value) {
  if (!value) return '未知'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '未知' : parsed.toLocaleString('zh-CN')
}

function cancel() {
  requestId += 1
  controller?.abort()
  controller = null
}

async function load() {
  cancel()
  billing.value = null
  error.value = ''
  const accountId = props.accountId
  const subscriptionId = props.subscriptionId
  if (!accountId || !subscriptionId) return
  const id = requestId
  const request = new AbortController()
  controller = request
  loading.value = true
  const current = () => id === requestId && !request.signal.aborted && props.accountId === accountId && props.subscriptionId === subscriptionId
  try {
    const response = await cloudApi.getAzureSubscriptionBilling(accountId, { subscriptionId }, { signal: request.signal })
    if (!current()) return
    billing.value = response.data
  } catch (failure) {
    if (current()) error.value = failure.response?.data?.error || failure.message
  } finally {
    if (current()) {
      loading.value = false
      controller = null
    }
  }
}

watch(() => [props.accountId, props.subscriptionId], load, { immediate: true })
onBeforeUnmount(cancel)
</script>

<style scoped>
.azure-billing:not(:first-child) { border-top: 1px solid var(--border-color, #d6d9e0); margin-top: 14px; padding-top: 14px; }
.billing-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.billing-header h3 { margin: 0; font-size: 15px; }
.billing-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 12px 0 8px; }
.billing-item { display: grid; gap: 4px; min-width: 0; }
.billing-label { color: var(--muted-text, #6b7280); font-size: 12px; }
.billing-item strong { overflow-wrap: anywhere; }
.billing-status { margin-top: 4px; }
.error-text { color: #b42318; }
@media (max-width: 760px) { .billing-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
