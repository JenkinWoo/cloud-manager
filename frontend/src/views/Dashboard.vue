<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>仪表盘</h1>
        <p>查看账户概览与当前任务状态。</p>
      </div>
      <button class="btn btn-ghost" @click="loadAll" :disabled="loading">
        <span :class="loading ? 'spinner' : ''">{{ loading ? '' : '刷新' }}</span>
      </button>
    </div>

    <div class="stats-grid">
      <div class="card stat-card">
        <div class="stat-icon">AC</div>
        <div class="stat-value">{{ accounts.length }}</div>
        <div class="stat-label">总账户数</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon">OCI</div>
        <div class="stat-value">{{ oracleAccounts.length }}</div>
        <div class="stat-label">Oracle 账户</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon">AWS</div>
        <div class="stat-value">{{ awsAccounts.length }}</div>
        <div class="stat-label">AWS 账户</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon">AZ</div>
        <div class="stat-value">{{ azureAccounts.length }}</div>
        <div class="stat-label">Azure 账户</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon">DNS</div>
        <div class="stat-value">{{ dnsAccounts.length }}</div>
        <div class="stat-label">DNS 账户</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon" style="color:var(--yellow)">RUN</div>
        <div class="stat-value" style="color:var(--yellow)">{{ pendingTasks }}</div>
        <div class="stat-label">运行中任务</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon" style="color:var(--text-secondary)">ON</div>
        <div class="stat-value" style="color:var(--text-secondary)">{{ enabledAccounts.length }}</div>
        <div class="stat-label">启用中的计算账户</div>
      </div>
    </div>

    <div v-if="accounts.length > 0" class="card overview-card">
      <div class="section-header">
        <h2>账户概览</h2>
      </div>
      <div class="overview-grid">
        <div v-for="account in accounts" :key="account.id" class="overview-item">
          <div class="overview-top">
            <div>
              <div class="overview-name">{{ account.name }}</div>
              <div class="overview-meta">{{ providerLabel(account.computeProvider) }}</div>
            </div>
            <span :class="['badge', account.enabled === false ? 'badge-stopped' : 'badge-running']">
              {{ account.enabled === false ? '已禁用' : '已启用' }}
            </span>
          </div>
          <div class="overview-extra">
            <span>ID: {{ shortText(account.id, 16) }}</span>
            <span>创建于 {{ formatDate(account.createdAt) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="dnsAccounts.length > 0" class="card overview-card">
      <div class="section-header">
        <h2>DNS 账户概览</h2>
      </div>
      <div class="overview-grid">
        <div v-for="account in dnsAccounts" :key="account.id" class="overview-item">
          <div class="overview-top">
            <div>
              <div class="overview-name">{{ account.name }}</div>
              <div class="overview-meta">{{ String(account.dnsProvider || '-').toUpperCase() }}</div>
            </div>
            <span :class="['badge', account.enabled === false ? 'badge-stopped' : 'badge-running']">
              {{ account.enabled === false ? '已禁用' : '已启用' }}
            </span>
          </div>
          <div class="overview-extra">
            <span>根域名 {{ account.credentials?.domainName || '-' }}</span>
            <span>创建于 {{ formatDate(account.createdAt) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!loading && accounts.length === 0 && dnsAccounts.length === 0" class="card empty-card">
      <div class="empty-title">欢迎使用云管理平台</div>
      <div class="empty-text">当前还没有配置任何计算账户或 DNS 账户。</div>
      <router-link to="/accounts" class="btn btn-primary">前往添加账户</router-link>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { accountsApi, tasksApi } from '../api/index.js'

const accounts = ref([])
const dnsAccounts = ref([])
const pendingTasks = ref(0)
const loading = ref(false)

const oracleAccounts = computed(() => accounts.value.filter((item) => item.computeProvider === 'oracle'))
const awsAccounts = computed(() => accounts.value.filter((item) => item.computeProvider === 'aws'))
const azureAccounts = computed(() => accounts.value.filter((item) => item.computeProvider === 'azure'))
const enabledAccounts = computed(() => accounts.value.filter((item) => item.enabled !== false))

onMounted(loadAll)

async function loadAll() {
  loading.value = true
  try {
    const [accountRes, dnsRes, taskRes] = await Promise.all([
      accountsApi.list(),
      accountsApi.listDns(),
      tasksApi.list({ status: 'running' })
    ])

    accounts.value = accountRes.data || []
    dnsAccounts.value = dnsRes.data || []
    pendingTasks.value = taskRes.data.length
  } catch (error) {
    window.$toast?.(`加载失败: ${error.message}`, 'error')
  } finally {
    loading.value = false
  }
}

function providerLabel(provider) {
  if (provider === 'oracle') return 'Oracle'
  if (provider === 'aws') return 'AWS'
  if (provider === 'azure') return 'Azure'
  return provider || '-'
}

function shortText(text, length = 18) {
  if (!text) return '-'
  return text.length <= length ? text : `${text.slice(0, length)}...`
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}
</script>

<style scoped>
.overview-card {
  margin-top: 24px;
}

.section-header {
  margin-bottom: 16px;
}

.section-header h2 {
  margin: 0;
  font-size: 15px;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.overview-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  background: var(--bg-elevated);
}

.overview-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.overview-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.overview-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.overview-extra {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.empty-card {
  margin-top: 24px;
  padding: 48px;
  text-align: center;
}

.empty-title {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 8px;
}

.empty-text {
  color: var(--text-muted);
  margin-bottom: 20px;
}

@media (max-width: 768px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
}
</style>
