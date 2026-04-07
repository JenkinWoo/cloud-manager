<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>账户管理</h1>
        <p>统一管理计算云账户与 DNS 账户。</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" @click="openAddDns">+ DNS 账户</button>
        <button class="btn btn-primary" @click="openAdd">+ 计算账户</button>
      </div>
    </div>

    <h2 class="section-title">计算账户</h2>
    <div v-if="accounts.length === 0" class="card empty-state section-gap">
      <div class="empty-icon">-</div>
      <p>暂无计算账户</p>
    </div>
    <div v-else class="card table-wrap section-gap">
      <table>
        <thead>
          <tr>
            <th>账户名</th>
            <th>Provider</th>
            <th>凭证摘要</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="account in accounts" :key="account.id">
            <td><span class="account-name">{{ account.name }}</span></td>
            <td><span :class="['badge', providerBadge(account.computeProvider)]">{{ account.computeProvider?.toUpperCase() }}</span></td>
            <td class="summary-cell">{{ computeCredentialSummary(account) }}</td>
            <td><span :class="['badge', account.enabled ? 'badge-running' : 'badge-stopped']">{{ account.enabled ? '启用' : '禁用' }}</span></td>
            <td class="summary-cell">{{ fmtDate(account.createdAt) }}</td>
            <td>
              <div class="action-row">
                <button class="btn btn-ghost btn-sm" @click="testAccount(account)" :disabled="testingId === account.id">
                  {{ testingId === account.id ? '...' : '测试' }}
                </button>
                <button class="btn btn-ghost btn-sm" @click="openEdit(account)">编辑</button>
                <button class="btn btn-danger btn-sm" @click="deleteAccount(account)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <h2 class="section-title">DNS 账户</h2>
    <div v-if="dnsAccounts.length === 0" class="card empty-state">
      <div class="empty-icon">-</div>
      <p>暂无 DNS 账户</p>
    </div>
    <div v-else class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>账户名</th>
            <th>Provider</th>
            <th>凭证摘要</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="account in dnsAccounts" :key="account.id">
            <td><span class="account-name">{{ account.name }}</span></td>
            <td><span class="badge badge-running">{{ account.dnsProvider?.toUpperCase() }}</span></td>
            <td class="summary-cell">{{ dnsCredentialSummary(account) }}</td>
            <td><span :class="['badge', account.enabled ? 'badge-running' : 'badge-stopped']">{{ account.enabled ? '启用' : '禁用' }}</span></td>
            <td>
              <div class="action-row">
                <button class="btn btn-ghost btn-sm" @click="testDns(account)" :disabled="testingDnsId === account.id">
                  {{ testingDnsId === account.id ? '...' : '测试' }}
                </button>
                <button class="btn btn-ghost btn-sm" @click="openEditDns(account)">编辑</button>
                <button class="btn btn-danger btn-sm" @click="deleteDns(account)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-overlay" @click.self="showModal = false">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ editTarget ? '编辑计算账户' : '新增计算账户' }}</h3>
          <button class="modal-close" @click="showModal = false">x</button>
        </div>

        <div class="form-group">
          <label>账户名 *</label>
          <input v-model="form.name" class="form-control" placeholder="例如：主力 Azure 账户" />
        </div>

        <div class="form-group">
          <label>计算 Provider *</label>
          <select v-model="form.computeProvider" class="form-control" :disabled="!!editTarget">
            <option v-for="provider in computeProviders" :key="provider.key" :value="provider.key">
              {{ provider.key.toUpperCase() }}
            </option>
          </select>
        </div>

        <template v-if="form.computeProvider === 'oracle'">
          <div class="form-group">
            <label>OCI Config *</label>
            <textarea v-model="cred.configText" class="form-control" rows="5" placeholder="粘贴 .oci/config 内容"></textarea>
          </div>
          <div class="form-group">
            <label>Private Key *</label>
            <textarea v-model="cred.privateKeyText" class="form-control" rows="6" placeholder="粘贴 oci_api_key.pem 内容"></textarea>
          </div>
        </template>

        <template v-else-if="form.computeProvider === 'aws'">
          <div class="form-group">
            <label>Access Key ID *</label>
            <input v-model="cred.accessKeyId" class="form-control" />
          </div>
          <div class="form-group">
            <label>Secret Access Key *</label>
            <input v-model="cred.secretAccessKey" class="form-control" type="password" />
          </div>
          <div class="form-group">
            <label>Region *</label>
            <input v-model="cred.region" class="form-control" placeholder="ap-southeast-1" />
          </div>
        </template>

        <template v-else-if="form.computeProvider === 'azure'">
          <div class="form-group">
            <label>Cloud Shell CLI JSON</label>
            <textarea
              v-model="cred.cliConfigText"
              class="form-control"
              rows="5"
              placeholder='可直接粘贴 Cloud Shell 返回的 JSON，例如 {"appId":"...","password":"...","tenant":"..."}'
            ></textarea>
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label>appId</label>
              <input v-model="cred.appId" class="form-control" />
            </div>
            <div class="form-group">
              <label>tenant</label>
              <input v-model="cred.tenant" class="form-control" />
            </div>
          </div>
          <div class="form-group">
            <label>password</label>
            <input v-model="cred.password" class="form-control" type="password" />
          </div>
        </template>

        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showModal = false">取消</button>
          <button class="btn btn-primary" @click="saveAccount" :disabled="saving">
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showDnsModal" class="modal-overlay" @click.self="showDnsModal = false">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ editDnsTarget ? '编辑 DNS 账户' : '新增 DNS 账户' }}</h3>
          <button class="modal-close" @click="showDnsModal = false">x</button>
        </div>

        <div class="form-group">
          <label>账户名 *</label>
          <input v-model="dnsForm.name" class="form-control" />
        </div>

        <div class="form-group">
          <label>DNS Provider *</label>
          <select v-model="dnsForm.dnsProvider" class="form-control" :disabled="!!editDnsTarget">
            <option v-for="provider in dnsProviders" :key="provider.key" :value="provider.key">
              {{ provider.key.toUpperCase() }}
            </option>
          </select>
        </div>

        <template v-if="dnsForm.dnsProvider === 'cloudflare'">
          <div class="form-group">
            <label>API Token *</label>
            <input v-model="dnsCred.apiToken" class="form-control" type="password" />
          </div>
          <div class="form-group">
            <label>Zone ID *</label>
            <input v-model="dnsCred.zoneId" class="form-control" />
          </div>
          <div class="form-group">
            <label>根域名 *</label>
            <input v-model="dnsCred.domainName" class="form-control" placeholder="example.com" />
          </div>
        </template>

        <template v-else-if="dnsForm.dnsProvider === 'aliyun'">
          <div class="form-group">
            <label>Access Key ID *</label>
            <input v-model="dnsCred.accessKeyId" class="form-control" />
          </div>
          <div class="form-group">
            <label>Access Key Secret *</label>
            <input v-model="dnsCred.accessKeySecret" class="form-control" type="password" />
          </div>
          <div class="form-group">
            <label>根域名 *</label>
            <input v-model="dnsCred.domainName" class="form-control" placeholder="frp.gs" />
          </div>
        </template>

        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showDnsModal = false">取消</button>
          <button class="btn btn-primary" @click="saveDns" :disabled="savingDns">
            {{ savingDns ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { accountsApi, providersApi } from '../api/index.js'

const accounts = ref([])
const dnsAccounts = ref([])
const computeProviders = ref([])
const dnsProviders = ref([])
const loading = ref(false)
const saving = ref(false)
const savingDns = ref(false)
const showModal = ref(false)
const showDnsModal = ref(false)
const editTarget = ref(null)
const editDnsTarget = ref(null)
const testingId = ref(null)
const testingDnsId = ref(null)

const defForm = () => ({ name: '', computeProvider: 'oracle' })
const defDnsForm = () => ({ name: '', dnsProvider: 'cloudflare' })

const form = ref(defForm())
const cred = ref({})
const dnsForm = ref(defDnsForm())
const dnsCred = ref({})

onMounted(async () => {
  const [, providerRes] = await Promise.all([load(), providersApi.list()])
  computeProviders.value = providerRes.data.compute || []
  dnsProviders.value = providerRes.data.dns || []
})

async function load() {
  loading.value = true
  try {
    const [accountRes, dnsRes] = await Promise.all([accountsApi.list(), accountsApi.listDns()])
    accounts.value = accountRes.data || []
    dnsAccounts.value = dnsRes.data || []
  } catch (error) {
    window.$toast?.(error.message, 'error')
  } finally {
    loading.value = false
  }
}

function openAdd() {
  editTarget.value = null
  form.value = defForm()
  cred.value = {}
  showModal.value = true
}

function openEdit(account) {
  editTarget.value = account
  form.value = { name: account.name, computeProvider: account.computeProvider }
  cred.value = { ...account.credentials }
  showModal.value = true
}

function openAddDns() {
  editDnsTarget.value = null
  dnsForm.value = defDnsForm()
  dnsCred.value = {}
  showDnsModal.value = true
}

function openEditDns(account) {
  editDnsTarget.value = account
  dnsForm.value = { name: account.name, dnsProvider: account.dnsProvider }
  dnsCred.value = { ...account.credentials }
  showDnsModal.value = true
}

function normalizeAzureCredentials() {
  const nextCred = { ...cred.value }
  const cliConfigText = String(nextCred.cliConfigText || '').trim()

  if (cliConfigText) {
    let parsed = null
    try {
      parsed = JSON.parse(cliConfigText)
    } catch (error) {
      throw new Error('Azure CLI JSON 格式不正确')
    }
    Object.assign(nextCred, parsed)
  }

  if (!nextCred.appId || !nextCred.password || !nextCred.tenant) {
    throw new Error('Azure 需要 appId、password、tenant，或直接粘贴 Cloud Shell JSON')
  }

  return nextCred
}

async function saveAccount() {
  if (!form.value.name) {
    return window.$toast?.('请填写账户名', 'error')
  }

  saving.value = true
  try {
    let nextCred = { ...cred.value }

    if (form.value.computeProvider === 'azure') {
      nextCred = normalizeAzureCredentials()
      cred.value = { ...nextCred }
    }

    const payload = { ...form.value, credentials: nextCred }
    if (editTarget.value) {
      await accountsApi.update(editTarget.value.id, payload)
    } else {
      await accountsApi.create(payload)
    }

    window.$toast?.('保存成功', 'success')
    showModal.value = false
    await load()
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    saving.value = false
  }
}

async function saveDns() {
  if (!dnsForm.value.name) {
    return window.$toast?.('请填写账户名', 'error')
  }

  if (dnsForm.value.dnsProvider === 'cloudflare') {
    if (!dnsCred.value.apiToken || !dnsCred.value.zoneId) {
      return window.$toast?.('Please fill API Token and Zone ID', 'error')
    }
    if (!dnsCred.value.domainName) {
      return window.$toast?.('Please fill the root domain, for example example.com', 'error')
    }
  }

  if (dnsForm.value.dnsProvider === 'aliyun') {
    if (!dnsCred.value.accessKeyId || !dnsCred.value.accessKeySecret) {
      return window.$toast?.('Please fill Access Key ID and Access Key Secret', 'error')
    }
    if (!dnsCred.value.domainName) {
      return window.$toast?.('Please fill the root domain, for example frp.gs', 'error')
    }
  }

  savingDns.value = true
  try {
    const payload = { ...dnsForm.value, credentials: { ...dnsCred.value } }
    if (editDnsTarget.value) {
      await accountsApi.updateDns(editDnsTarget.value.id, payload)
    } else {
      await accountsApi.createDns(payload)
    }

    window.$toast?.('保存成功', 'success')
    showDnsModal.value = false
    await load()
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    savingDns.value = false
  }
}

async function deleteAccount(account) {
  if (!window.confirm(`确认删除账户「${account.name}」吗？`)) return
  try {
    await accountsApi.delete(account.id)
    window.$toast?.('已删除', 'success')
    await load()
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  }
}

async function deleteDns(account) {
  if (!window.confirm(`确认删除 DNS 账户「${account.name}」吗？`)) return
  try {
    await accountsApi.deleteDns(account.id)
    window.$toast?.('已删除', 'success')
    await load()
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  }
}

async function testAccount(account) {
  testingId.value = account.id
  try {
    await accountsApi.test(account.id)
    window.$toast?.(`「${account.name}」连接成功`, 'success')
  } catch (error) {
    window.$toast?.(`连接失败: ${error.response?.data?.error || error.message}`, 'error')
  } finally {
    testingId.value = null
  }
}

async function testDns(account) {
  testingDnsId.value = account.id
  try {
    await accountsApi.testDns(account.id)
    window.$toast?.(`「${account.name}」连接成功`, 'success')
  } catch (error) {
    window.$toast?.(`连接失败: ${error.response?.data?.error || error.message}`, 'error')
  } finally {
    testingDnsId.value = null
  }
}

function maskKey(value) {
  if (!value) return '-'
  const text = String(value)
  if (text.length <= 10) return text
  return `${text.slice(0, 6)}...${text.slice(-4)}`
}

function computeCredentialSummary(account) {
  if (account.computeProvider === 'oracle') {
    return `配置已保存 · ${account.credentials?.configText ? 'YES' : 'NO'}`
  }
  if (account.computeProvider === 'aws') {
    return `${account.credentials?.region || '-'} · ${maskKey(account.credentials?.accessKeyId)}`
  }
  if (account.computeProvider === 'azure') {
    return `${maskKey(account.credentials?.tenant)} · ${maskKey(account.credentials?.appId)}`
  }
  return '-'
}

function dnsCredentialSummary(account) {
  if (account.dnsProvider === 'cloudflare') {
    return `Zone: ${String(account.credentials?.zoneId || '').slice(0, 8) || '-'} · Domain: ${account.credentials?.domainName || '-'}`
  }
  if (account.dnsProvider === 'aliyun') {
    return `${maskKey(account.credentials?.accessKeyId)} · ${account.credentials?.domainName || '-'}`
  }
  return '-'
}

function fmtDate(value) {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '-'
}

function providerBadge(provider) {
  if (provider === 'oracle') return 'badge-oracle'
  if (provider === 'aws') return 'badge-aws'
  if (provider === 'azure') return 'badge-azure'
  return 'badge-pending'
}
</script>

<style scoped>
.header-actions {
  display: flex;
  gap: 8px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.section-gap {
  margin-bottom: 20px;
}

.account-name {
  font-weight: 500;
}

.summary-cell {
  font-size: 11px;
  color: var(--text-muted);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 768px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
