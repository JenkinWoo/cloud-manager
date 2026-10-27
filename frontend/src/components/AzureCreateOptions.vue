<template>
  <section class="azure-options" aria-label="免费额度实例推荐">
    <div class="options-heading">
      <strong>按当前订阅免费计费记录推荐</strong>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="loading || disabled" @click="emit('refresh')">刷新推荐</button>
    </div>
    <p v-if="loading" class="form-hint" role="status">正在自动读取计算和磁盘的 Free 计费记录、已有资源及区域配额…</p>
    <p v-else-if="error" class="form-hint" role="alert">{{ error }}</p>
    <template v-else-if="result">
      <p class="form-hint">检查时间：{{ new Date(result.checkedAt).toLocaleString() }}。</p>
      <p v-if="result.benefit" class="form-hint">依据当前订阅本月明确标为 Free 的计算和磁盘记录自动筛选，无需账户设置。每种机型 750 小时、两块 P6 是应用采用的计划上限，并非 Azure 返回的剩余额度；免费记录也不保证后续免费。</p>
      <p v-if="!result.options.length" class="form-hint">暂无通过检查的组合。下方会说明缺少免费计费记录、已有资源占用或配额不足等原因。</p>
      <ul v-else class="options-list">
        <li v-for="option in result.options" :key="`${option.location}/${option.vmSize}`">
          <div>
            <strong>{{ option.displayName }} ({{ option.location }}) · {{ option.vmSize }} · {{ option.architecture }}</strong>
            <p class="form-hint">{{ option.numberOfCores }} vCPU · {{ option.memoryInMB / 1024 }} GB；剩余 CPU {{ option.cpuQuota.remainingCores }} 核 · 64 GiB P6 系统盘 · 默认私网，可选收费公网 IP</p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled || result.costPolicy?.creationAllowed !== true" @click="emit('select', option)">选择</button>
        </li>
      </ul>
      <details :open="!result.options.length" v-if="result.regions.some(region => region.status !== 'ready' || region.sizes.some(size => !size.available))">
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
defineProps({
  result: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'refresh'])
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
