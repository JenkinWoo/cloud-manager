<template>
  <section class="azure-options" aria-label="免费候选组合">
    <div class="options-heading">
      <strong>当前订阅的免费候选组合</strong>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="loading || disabled" @click="load">刷新推荐</button>
    </div>
    <p v-if="loading" class="form-hint" role="status">正在检查允许区域的规格、CPU 和公网 IP 配额…</p>
    <p v-else-if="error" class="form-hint" role="alert">{{ error }}</p>
    <template v-else-if="result">
      <p class="form-hint">检查时间：{{ new Date(result.checkedAt).toLocaleString() }}。预检通过不保证实时容量或最终免费权益。</p>
      <p v-if="!result.options.length" class="form-hint">本次没有预检通过的组合，请查看各区域原因或刷新重试。</p>
      <ul v-else class="options-list">
        <li v-for="option in result.options" :key="`${option.location}/${option.vmSize}`">
          <div>
            <strong>{{ option.displayName }} ({{ option.location }}) · {{ option.vmSize }}</strong>
            <p class="form-hint">{{ option.numberOfCores }} vCPU · {{ option.memoryInMB / 1024 }} GB；剩余 CPU {{ option.cpuQuota.remainingCores }} 核，公网 IP {{ option.publicIpQuota.remainingAddresses }} 个</p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled" @click="emit('select', option)">选择</button>
        </li>
      </ul>
      <details v-if="result.regions.some(region => region.status !== 'ready' || region.sizes.some(size => !size.available))">
        <summary>查看未通过或未完成的检查</summary>
        <div v-for="region in result.regions" :key="region.location">
          <p v-if="region.reason" class="form-hint">{{ region.location }}：{{ region.reason }}</p>
          <template v-for="size in region.sizes" :key="size.name">
            <p v-if="!size.available" class="form-hint">{{ region.location }} / {{ size.name }}：{{ size.restrictionReason }}</p>
          </template>
        </div>
      </details>
    </template>
  </section>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { cloudApi } from '../api/index.js'

const props = defineProps({
  accountId: { type: String, required: true },
  subscriptionId: { type: String, required: true },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['select'])
const result = ref(null)
const error = ref('')
const loading = ref(false)
let controller = null
let requestId = 0

function cancel() {
  requestId++
  controller?.abort()
  controller = null
}

async function load() {
  cancel()
  result.value = null
  error.value = ''
  loading.value = false
  const { accountId, subscriptionId } = props
  if (!accountId || !subscriptionId) return
  const id = requestId
  const request = new AbortController()
  controller = request
  loading.value = true
  const current = () => id === requestId && !request.signal.aborted &&
    props.accountId === accountId && props.subscriptionId === subscriptionId
  try {
    const { data } = await cloudApi.listAzureCreateOptions(accountId, { subscriptionId }, { signal: request.signal })
    if (!current()) return
    if (data.subscriptionId !== subscriptionId) throw new Error('推荐结果的订阅不匹配，请刷新重试')
    result.value = data
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
.azure-options { border: 1px solid var(--border-color, #d6d9e0); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
.options-heading, .options-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.options-list { list-style: none; padding: 0; margin: 8px 0; max-height: 260px; overflow-y: auto; }
.options-list li { padding: 8px 0; }
.options-list strong { font-size: 13px; overflow-wrap: anywhere; }
.options-list button { flex-shrink: 0; }
summary { cursor: pointer; font-size: 13px; }
</style>
