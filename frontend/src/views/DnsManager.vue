<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>DNS 管理</h1>
        <p>查看并管理当前 DNS 账户下的解析记录</p>
      </div>
    </div>

    <div class="account-selector">
      <span v-if="loadingAccounts" class="account-loading">加载 DNS 账户中...</span>
      <template v-else-if="dnsAccounts.length">
        <button
          v-for="account in dnsAccounts"
          :key="account.id"
          type="button"
          :class="['account-chip', selectedDnsAccountId === account.id ? 'active' : '']"
          @click="selectDnsAccount(account.id)"
        >
          <span class="chip-provider">{{ dnsProviderToken(account.dnsProvider) }}</span>
          <span>{{ dnsProviderLabel(account.dnsProvider) }} / {{ account.name }}</span>
        </button>
      </template>
      <span v-else class="account-loading">当前还没有 DNS 账户</span>
    </div>

    <div v-if="currentDomainName" class="card domain-card">
      <div class="domain-title">当前主域名</div>
      <div class="domain-name">{{ currentDomainName }}</div>
      <div class="domain-hint">
        记录名称只需填写前缀，例如 `www`；未填写后缀时会自动补全为 `{{ currentDomainName }}`。
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <h3 class="section-heading">新增或更新记录</h3>
      <div class="form-row">
        <div class="form-group form-grow">
          <label>记录名称</label>
          <input v-model="quickForm.recordName" class="form-control" :placeholder="recordNamePlaceholder"
            @blur="normalizeEditorName" />
        </div>
        <div class="form-group form-grow-sm">
          <label>记录值</label>
          <input v-model="quickForm.recordContent" class="form-control" placeholder="1.2.3.4" />
        </div>
        <div class="form-group form-type">
          <label>类型</label>
          <select v-model="quickForm.recordType" class="form-control">
            <option>A</option>
            <option>AAAA</option>
            <option>CNAME</option>
            <option>TXT</option>
          </select>
        </div>
        <div v-if="showProxyToggle" class="form-group form-toggle">
          <label>Cloudflare 代理</label>
          <label class="switch-label">
            <input v-model="quickForm.proxied" type="checkbox" class="switch-input" />
            <span class="switch-track">
              <span class="switch-thumb"></span>
            </span>
            <span>{{ quickForm.proxied ? '启用 Proxy' : '仅 DNS' }}</span>
          </label>
        </div>
        <button class="btn btn-primary" @click="upsertRecord" :disabled="saving" style="margin-bottom:0">
          {{ saving ? '保存中...' : (editingRecord ? '更新记录' : '创建记录') }}
        </button>
        <button v-if="editingRecord" class="btn btn-ghost" @click="resetEditor" style="margin-bottom:0">
          取消编辑
        </button>
      </div>
    </div>

    <div class="card">
      <div class="records-head">
        <h3 class="section-heading" style="margin:0">已有记录</h3>
        <div class="records-tools">
          <input v-model.trim="recordSearch" class="form-control record-search" placeholder="搜索名称、类型或内容"
            :disabled="loadingRecords || !records.length" />
          <button class="btn btn-ghost btn-sm" @click="loadRecords" :disabled="loadingRecords || !selectedDnsAccountId">
            {{ loadingRecords ? '加载中...' : '刷新列表' }}
          </button>
        </div>
      </div>

      <div v-if="!selectedDnsAccountId" class="empty-text">请先选择 DNS 账户</div>
      <div v-else-if="loadingRecords" class="loading-wrap">
        <div class="spinner"></div>
      </div>
      <div v-else-if="records.length === 0" class="empty-text">暂无解析记录</div>
      <div v-else-if="filteredRecords.length === 0" class="empty-text">没有匹配的解析记录</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>内容</th>
              <th>TTL</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in filteredRecords" :key="record.id || `${record.name}-${record.type}-${record.content}`">
              <td>{{ record.name }}</td>
              <td>{{ record.type }}</td>
              <td><span class="record-content" :title="record.content">{{ record.content }}</span></td>
              <td>{{ record.ttl ?? '自动' }}</td>
              <td>
                <span :class="['badge', record.proxied ? 'badge-running' : 'badge-stopped']">
                  {{ record.proxied ? '代理' : '仅 DNS' }}
                </span>
              </td>
              <td>
                <div v-if="canManageRecord(record)" class="action-row">
                  <button class="btn btn-ghost btn-sm" @click="editRecord(record)">编辑</button>
                  <button class="btn btn-danger btn-sm" @click="deleteFromRow(record)">删除</button>
                </div>
                <span v-else class="record-note">系统记录</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { accountsApi, dnsApi } from '../api/index.js'

const dnsAccounts = ref([])
const selectedDnsAccountId = ref('')
const loadingAccounts = ref(true)
const loadingRecords = ref(false)
const records = ref([])
const recordSearch = ref('')
const MANAGEABLE_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT'])
let recordsRequestId = 0

const DNS_PROVIDER_LABELS = {
  cloudflare: 'Cloudflare',
  aliyun: 'Aliyun DNS',
  tencentcloud: 'Tencent Cloud DNSPod',
  huaweicloud: 'Huawei Cloud DNS'
}

const saving = ref(false)
const deleting = ref(false)
const editingRecord = ref(null)
const quickForm = ref({ recordName: '', recordContent: '', recordType: 'A', proxied: false })
const delForm = ref({ recordName: '', recordType: 'A' })

const currentDnsAccount = computed(() =>
  dnsAccounts.value.find((item) => item.id === selectedDnsAccountId.value) || null
)

const currentDomainName = computed(() => {
  const domainName = currentDnsAccount.value?.credentials?.domainName
  return domainName ? String(domainName).trim().toLowerCase().replace(/\.$/, '') : ''
})

const recordNamePlaceholder = computed(() => (
  currentDomainName.value ? '例如 www 或 @' : '请输入完整记录名称'
))

const showProxyToggle = computed(() => (
  currentDnsAccount.value?.dnsProvider === 'cloudflare'
  && ['A', 'AAAA', 'CNAME'].includes(quickForm.value.recordType)
))

const filteredRecords = computed(() => {
  const keyword = recordSearch.value.trim().toLowerCase()
  if (!keyword) return records.value

  return records.value.filter((record) => {
    const searchable = [
      record.name,
      record.type,
      record.content,
      record.ttl ?? '自动',
      record.proxied ? '代理 proxied' : '仅 dns dns only'
    ].join(' ').toLowerCase()

    return searchable.includes(keyword)
  })
})

function normalizeDomainName(domainName) {
  return String(domainName || '').trim().toLowerCase().replace(/\.$/, '')
}

function toFullRecordName(input) {
  const normalizedInput = String(input || '').trim().toLowerCase().replace(/\.$/, '')
  if (!normalizedInput) return ''

  const domainName = currentDomainName.value
  if (!domainName) return normalizedInput
  if (normalizedInput === '@') return domainName
  if (normalizedInput === domainName) return domainName

  const suffix = `.${domainName}`
  if (normalizedInput.endsWith(suffix)) return normalizedInput
  if (normalizedInput.includes('.')) {
    throw new Error(`记录 "${normalizedInput}" 不属于主域名 ${domainName}`)
  }

  return `${normalizedInput}${suffix}`
}

function toShortRecordName(fullName) {
  const normalized = normalizeDomainName(fullName)
  const domainName = currentDomainName.value
  if (!normalized || !domainName) return normalized
  if (normalized === domainName) return '@'

  const suffix = `.${domainName}`
  if (normalized.endsWith(suffix)) {
    return normalized.slice(0, -suffix.length) || '@'
  }

  return normalized
}

function normalizeEditorName() {
  quickForm.value.recordName = toShortRecordName(quickForm.value.recordName)
}

function normalizeDeleteName() {
  delForm.value.recordName = toShortRecordName(delForm.value.recordName)
}

function selectDnsAccount(id) {
  if (selectedDnsAccountId.value === id) return
  selectedDnsAccountId.value = id
}

onMounted(async () => {
  try {
    const res = await accountsApi.listDns()
    dnsAccounts.value = res.data
    if (dnsAccounts.value.length > 0) {
      selectedDnsAccountId.value = dnsAccounts.value[0].id
    }
  } catch (e) {
    window.$toast?.(`加载 DNS 账户失败: ${e.message}`, 'error')
  } finally {
    loadingAccounts.value = false
  }
})

watch(selectedDnsAccountId, async (value) => {
  resetEditor()
  delForm.value = { recordName: '', recordType: 'A' }
  recordSearch.value = ''
  records.value = []
  if (!value) {
    recordsRequestId += 1
    loadingRecords.value = false
    return
  }
  await loadRecords(value)
})

async function loadRecords(accountId = selectedDnsAccountId.value) {
  if (!accountId) return

  const requestId = ++recordsRequestId
  loadingRecords.value = true
  try {
    const res = await dnsApi.listRecords(accountId)
    if (requestId !== recordsRequestId || accountId !== selectedDnsAccountId.value) {
      return
    }
    records.value = res.data
  } catch (e) {
    if (requestId !== recordsRequestId || accountId !== selectedDnsAccountId.value) {
      return
    }
    window.$toast?.(e.response?.data?.error || e.message, 'error')
  } finally {
    if (requestId === recordsRequestId) {
      loadingRecords.value = false
    }
  }
}

function resetEditor() {
  editingRecord.value = null
  quickForm.value = { recordName: '', recordContent: '', recordType: 'A', proxied: false }
}

function editRecord(record) {
  if (!canManageRecord(record)) {
    window.$toast?.(`${record.type} 系统记录不支持在此处编辑`, 'error')
    return
  }

  editingRecord.value = record
  quickForm.value = {
    recordName: toShortRecordName(record.name),
    recordContent: record.content,
    recordType: record.type,
    proxied: Boolean(record.proxied)
  }
}

async function upsertRecord() {
  if (!quickForm.value.recordName || !quickForm.value.recordContent) {
    return window.$toast?.('请填写记录名称和记录值', 'error')
  }
  if (!selectedDnsAccountId.value) {
    return window.$toast?.('请先选择 DNS 账户', 'error')
  }

  let recordName
  try {
    recordName = toFullRecordName(quickForm.value.recordName)
  } catch (e) {
    return window.$toast?.(e.message, 'error')
  }

  saving.value = true
  try {
    await dnsApi.upsertRecord(selectedDnsAccountId.value, {
      name: recordName,
      content: quickForm.value.recordContent,
      type: quickForm.value.recordType,
      options: showProxyToggle.value ? { proxied: quickForm.value.proxied } : {}
    })
    window.$toast?.(editingRecord.value ? 'DNS 记录已更新' : 'DNS 记录已创建', 'success')
    resetEditor()
    await loadRecords()
  } catch (e) {
    window.$toast?.(e.response?.data?.error || e.message, 'error')
  } finally {
    saving.value = false
  }
}

async function removeRecord(recordName, recordType) {
  if (!selectedDnsAccountId.value) {
    return window.$toast?.('请先选择 DNS 账户', 'error')
  }

  let fullRecordName
  try {
    fullRecordName = toFullRecordName(recordName)
  } catch (e) {
    return window.$toast?.(e.message, 'error')
  }

  if (!confirm(`确认删除 DNS 记录“${fullRecordName}”吗？`)) {
    return
  }

  deleting.value = true
  try {
    await dnsApi.deleteRecord(selectedDnsAccountId.value, {
      name: fullRecordName,
      type: recordType
    })
    window.$toast?.('DNS 记录已删除', 'success')
    if (editingRecord.value?.name === fullRecordName && editingRecord.value?.type === recordType) {
      resetEditor()
    }
    if (toFullRecordName(delForm.value.recordName) === fullRecordName && delForm.value.recordType === recordType) {
      delForm.value = { recordName: '', recordType: 'A' }
    }
    await loadRecords()
  } catch (e) {
    window.$toast?.(e.response?.data?.error || e.message, 'error')
  } finally {
    deleting.value = false
  }
}

async function deleteRecord() {
  if (!delForm.value.recordName) {
    return window.$toast?.('请填写记录名称', 'error')
  }
  await removeRecord(delForm.value.recordName, delForm.value.recordType)
}

async function deleteFromRow(record) {
  if (!canManageRecord(record)) {
    window.$toast?.(`${record.type} 系统记录不支持在此处删除`, 'error')
    return
  }
  await removeRecord(record.name, record.type)
}

function dnsProviderLabel(provider) {
  return DNS_PROVIDER_LABELS[provider] || String(provider || '-').toUpperCase()
}

function dnsProviderToken(provider) {
  const tokens = {
    cloudflare: 'CF',
    aliyun: 'ALI',
    tencentcloud: 'DNSP',
    huaweicloud: 'HW'
  }
  return tokens[provider] || String(provider || '--').slice(0, 4).toUpperCase()
}

function canManageRecord(record) {
  return MANAGEABLE_RECORD_TYPES.has(String(record?.type || '').toUpperCase())
}
</script>

<style scoped>
.domain-card {
  margin-bottom: 20px;
  background: linear-gradient(135deg, rgba(28, 118, 255, 0.08), rgba(9, 24, 61, 0.04));
  border: 1px solid rgba(28, 118, 255, 0.16);
}

.domain-title {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.domain-name {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
  margin-bottom: 6px;
}

.domain-hint,
.field-hint,
.empty-text {
  color: var(--text-muted);
  font-size: 13px;
}

.account-loading {
  font-size: 13px;
  color: var(--text-muted);
}

.chip-provider {
  font-family: Consolas, monospace;
  font-size: 11px;
  opacity: 0.8;
}

.section-heading {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 16px;
}

.form-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: flex-end;
}

.form-grow {
  flex: 1;
  min-width: 220px;
  margin-bottom: 0;
}

.form-grow-sm {
  flex: 1;
  min-width: 180px;
  margin-bottom: 0;
}

.form-type {
  min-width: 110px;
  margin-bottom: 0;
}

.form-toggle {
  min-width: 168px;
  margin-bottom: 0;
}

.switch-label {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.switch-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.switch-track {
  position: relative;
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: var(--border);
  transition: background-color 0.2s ease;
  flex-shrink: 0;
}

.switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s ease;
}

.switch-input:checked+.switch-track {
  background: var(--accent);
}

.switch-input:checked+.switch-track .switch-thumb {
  transform: translateX(18px);
}

.records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.records-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.record-search {
  width: 260px;
  min-width: 220px;
}

.loading-wrap {
  display: flex;
  justify-content: center;
  padding: 20px 0;
}

.record-note {
  font-size: 12px;
  color: var(--text-muted);
}

.record-content {
  display: inline-block;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
  font-family: monospace;
  font-size: 12px;
}

@media (max-width: 640px) {

  .records-head,
  .records-tools,
  .record-search {
    width: 100%;
  }

  .records-tools {
    justify-content: stretch;
  }
}
</style>
