<template>
  <div>
    <div v-if="services.length" class="detail-controls">
      <label><input v-model="chargedOnly" type="checkbox"> 仅显示非零费用</label>
      <span>共 {{ filtered.length }} 项</span>
      <label class="page-size-control">每页
        <select v-model.number="pageSize" aria-label="每页条数">
          <option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
        </select>
        条
      </label>
      <span v-if="filtered.length">显示 {{ rangeStart }}–{{ rangeEnd }}</span>
    </div>
    <p v-if="!services.length" class="empty-text">该时间范围尚未返回用量明细，不能据此判断服务永久免费。</p>
    <p v-else-if="!filtered.length" class="empty-text">已返回的明细均为零费用。</p>
    <div v-else class="billing-table-wrap">
      <table class="billing-table">
        <thead><tr><th>服务 / 扣费项目</th><th>资源 / 区域</th><th>用量</th><th>单价</th><th>费用</th></tr></thead>
        <tbody><tr v-for="(row, index) in visibleRows" :key="rowKey(row, index)">
          <td><strong>{{ row.service }}</strong><small>{{ row.meter || '未提供计量项' }}</small><small v-if="row.chargeType">{{ row.chargeType }}</small></td>
          <td><span class="resource-name" :title="row.resource">{{ resourceName(row.resource) }}</span><small v-if="row.region">{{ row.region }}</small><details v-if="row.resource"><summary>完整资源 ID</summary><small>{{ row.resource }}</small></details></td>
          <td>{{ quantity(row.usage) }}<small>{{ row.unit || '单位未提供' }}</small></td>
          <td>{{ row.unitPrice === null || row.unitPrice === undefined ? '—' : money(row.unitPrice, row.currency) }}</td>
          <td :class="{ charged: row.amount > 0, credit: row.amount < 0 }"><strong>{{ money(row.amount, row.currency) }}</strong></td>
        </tr></tbody>
      </table>
    </div>
    <nav v-if="pages > 1" class="pagination" aria-label="账单明细分页">
      <button class="btn btn-ghost btn-sm" :disabled="page === 1" @click="page--">上一页</button>
      <button v-for="item in pageNumbers" :key="item" class="btn btn-ghost btn-sm" :class="{ active: item === page }" @click="page = item">{{ item }}</button>
      <button class="btn btn-ghost btn-sm" :disabled="page === pages" @click="page++">下一页</button>
      <label class="jump-control">跳转到
        <select v-model.number="page" aria-label="跳转页码">
          <option v-for="item in pages" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
    </nav>
  </div>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { money } from '../utils/billing.js'

const props = defineProps({ services: { type: Array, default: () => [] } })
const pageSizes = [20, 50, 100]
const chargedOnly = ref(false)
const page = ref(1)
const pageSize = ref(50)
const filtered = computed(() => props.services.filter(row => !chargedOnly.value || row.amount !== 0))
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))
const visibleRows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const rangeStart = computed(() => (page.value - 1) * pageSize.value + 1)
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, filtered.value.length))
const pageNumbers = computed(() => Array.from({ length: pages.value }, (_, index) => index + 1))

watch([() => props.services, chargedOnly, pageSize], () => { page.value = 1 })
watch([filtered, pages], () => { if (page.value > pages.value) page.value = pages.value })

function quantity(value) { return value === null || value === undefined ? '未提供' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 }).format(value) }
function resourceName(value) { return value?.split('/').filter(Boolean).at(-1) || '未提供资源级明细' }
function rowKey(row, index) { return `${row.service || ''}/${row.meter || ''}/${row.resource || ''}/${row.periodStart || ''}/${index}` }
</script>
<style scoped>
.detail-controls, .pagination { display: flex; align-items: center; gap: 12px; color: var(--text-secondary); font-size: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.detail-controls label, .page-size-control, .jump-control { display: inline-flex; gap: 6px; align-items: center; }
.detail-controls select, .jump-control select { min-width: 58px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-input); color: inherit; }
.billing-table-wrap { overflow-x: auto; }
.billing-table { width: 100%; border-collapse: collapse; table-layout: fixed; min-width: 700px; }
.billing-table th, .billing-table td { padding: 12px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
.billing-table th { color: var(--text-secondary); font-size: 12px; }
.billing-table th:nth-child(1) { width: 25%; } .billing-table th:nth-child(2) { width: 31%; }
.billing-table th:nth-child(n+3) { width: 14.66%; }
small { display: block; color: var(--text-secondary); font-size: 12px; margin-top: 4px; }
.resource-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details { color: var(--text-secondary); font-size: 12px; margin-top: 4px; } summary { cursor: pointer; }
.charged { color: var(--orange); } .credit { color: var(--green); }
.empty-text { color: var(--text-secondary); padding: 16px 0; }
.pagination { justify-content: flex-end; margin: 12px 0 0; }
.pagination .active { color: var(--accent); border-color: var(--accent); }
</style>
