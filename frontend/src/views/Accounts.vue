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
            <th>排序</th>
            <th>账户名</th>
            <th>Provider</th>
            <th>凭证摘要</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(account, index) in accounts" :key="account.id">
            <td>
              <div class="sort-actions">
                <button
                  class="btn btn-ghost btn-sm sort-button"
                  :disabled="index === 0 || sortingId === account.id"
                  aria-label="Move up"
                  title="Move up"
                  @click="moveAccount(index, -1)"
                >
                  ⬆️
                </button>
                <button
                  class="btn btn-ghost btn-sm sort-button"
                  :disabled="index === accounts.length - 1 || sortingId === account.id"
                  aria-label="Move down"
                  title="Move down"
                  @click="moveAccount(index, 1)"
                >
                  ⬇️
                </button>
              </div>
            </td>
            <td><span class="account-name">{{ account.name }}</span></td>
            <td>
              <span :class="['badge', providerBadge(account.computeProvider)]" :title="providerTitle(account)">
                {{ providerLabel(account) }}
              </span>
            </td>
            <td class="summary-cell">{{ computeCredentialSummary(account) }}</td>
            <td>
              <button
                :class="['badge', 'status-toggle', isEnabled(account) ? 'badge-running' : 'badge-stopped']"
                :disabled="togglingId === account.id"
                :title="isEnabled(account) ? '点击停用账户' : '点击启用账户'"
                @click="toggleAccount(account)"
              >
                {{ isEnabled(account) ? '启用' : '禁用' }}
              </button>
            </td>
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
            <th>排序</th>
            <th>账户名</th>
            <th>Provider</th>
            <th>凭证摘要</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(account, index) in dnsAccounts" :key="account.id">
            <td>
              <div class="sort-actions">
                <button
                  class="btn btn-ghost btn-sm sort-button"
                  :disabled="index === 0 || sortingDnsId === account.id"
                  aria-label="Move up"
                  title="Move up"
                  @click="moveDnsAccount(index, -1)"
                >
                  ⬆️
                </button>
                <button
                  class="btn btn-ghost btn-sm sort-button"
                  :disabled="index === dnsAccounts.length - 1 || sortingDnsId === account.id"
                  aria-label="Move down"
                  title="Move down"
                  @click="moveDnsAccount(index, 1)"
                >
                  ⬇️
                </button>
              </div>
            </td>
            <td><span class="account-name">{{ account.name }}</span></td>
            <td><span class="badge badge-running">{{ dnsProviderLabel(account.dnsProvider) }}</span></td>
            <td class="summary-cell">{{ dnsCredentialSummary(account) }}</td>
            <td>
              <button
                :class="['badge', 'status-toggle', isEnabled(account) ? 'badge-running' : 'badge-stopped']"
                :disabled="togglingDnsId === account.id"
                :title="isEnabled(account) ? '点击停用 DNS 账户' : '点击启用 DNS 账户'"
                @click="toggleDnsAccount(account)"
              >
                {{ isEnabled(account) ? '启用' : '禁用' }}
              </button>
            </td>
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
            <label>账户类型</label>
            <select v-model="form.oracleAccountTypeMode" class="form-control">
              <option value="auto">自动检测</option>
              <option value="free">免费账户</option>
              <option value="upgraded">升级账户</option>
            </select>
          </div>
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
              {{ dnsProviderLabel(provider.key) }}
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

        <template v-else-if="dnsForm.dnsProvider === 'tencentcloud'">
          <div class="form-group">
            <label>SecretId *</label>
            <input v-model="dnsCred.secretId" class="form-control" />
          </div>
          <div class="form-group">
            <label>SecretKey *</label>
            <input v-model="dnsCred.secretKey" class="form-control" type="password" />
          </div>
          <div class="form-group">
            <label>根域名 *</label>
            <input v-model="dnsCred.domainName" class="form-control" placeholder="example.com" />
          </div>
        </template>

        <template v-else-if="dnsForm.dnsProvider === 'huaweicloud'">
          <div class="form-group">
            <label>Access Key ID (AK) *</label>
            <input v-model="dnsCred.accessKeyId" class="form-control" />
          </div>
          <div class="form-group">
            <label>Secret Access Key (SK) *</label>
            <input v-model="dnsCred.secretAccessKey" class="form-control" type="password" />
          </div>
          <div class="form-group">
            <label>根域名 *</label>
            <input v-model="dnsCred.domainName" class="form-control" placeholder="example.com" />
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
const sortingId = ref(null)
const sortingDnsId = ref(null)
const togglingId = ref(null)
const togglingDnsId = ref(null)
const oracleAccountTypes = ref({})
const oracleTypeLoadToken = ref(0)
const ORACLE_ACCOUNT_TYPE_CACHE_VERSION = 6

const DNS_PROVIDER_LABELS = {
  cloudflare: 'Cloudflare',
  aliyun: 'Aliyun DNS',
  tencentcloud: 'Tencent Cloud DNSPod',
  huaweicloud: 'Huawei Cloud DNS'
}

const defForm = () => ({ name: '', computeProvider: 'oracle', oracleAccountTypeMode: 'auto' })
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
    const [accountRes, dnsRes] = await Promise.all([
      accountsApi.list({ includeDisabled: true }),
      accountsApi.listDns({ includeDisabled: true })
    ])
    accounts.value = accountRes.data || []
    dnsAccounts.value = dnsRes.data || []
    loadMissingOracleAccountTypes()
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
  form.value = {
    name: account.name,
    computeProvider: account.computeProvider,
    oracleAccountTypeMode: account.oracleAccountTypeMode || 'auto'
  }
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

    const payload = {
      ...form.value,
      oracleAccountTypeMode: form.value.computeProvider === 'oracle' ? form.value.oracleAccountTypeMode : undefined,
      credentials: nextCred
    }
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

  const dnsValidationError = validateDnsCredentials(dnsForm.value.dnsProvider, dnsCred.value)
  if (dnsValidationError) {
    return window.$toast?.(dnsValidationError, 'error')
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
    const response = await accountsApi.test(account.id)
    if (isOracleAccount(account) && response.data?.oracleAccountType) {
      keepOracleAccountType(account.id, normalizeOracleAccountType(response.data.oracleAccountType))
    }
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

function isEnabled(account) {
  return account?.enabled !== false
}

function isOracleAccount(account) {
  return account?.computeProvider === 'oracle'
}

function replaceById(items, nextItem) {
  return items.map((item) => (item.id === nextItem.id ? nextItem : item))
}

function isValidOracleAccountType(data) {
  return (
    ['upgraded', 'free', 'unknown'].includes(data?.type) &&
    data.cacheVersion === ORACLE_ACCOUNT_TYPE_CACHE_VERSION
  )
}

function oracleAccountTypeInfo(account) {
  if (isValidOracleAccountType(account?.oracleAccountType)) return account.oracleAccountType
  return oracleAccountTypes.value[account.id] || {
    type: 'loading',
    label: '检测中',
    reason: '正在读取 OCI 订阅信息'
  }
}

function normalizeOracleAccountType(data) {
  if (['upgraded', 'free', 'unknown'].includes(data?.type)) {
    return {
      ...data,
      cacheVersion: data.cacheVersion || ORACLE_ACCOUNT_TYPE_CACHE_VERSION
    }
  }
  return {
    type: 'unknown',
    label: '未知',
    reason: '接口返回的账户类型无法识别',
    cacheVersion: ORACLE_ACCOUNT_TYPE_CACHE_VERSION
  }
}

function providerLabel(account) {
  const provider = String(account?.computeProvider || '-').toUpperCase()
  if (!isOracleAccount(account)) return provider

  const info = oracleAccountTypeInfo(account)
  return `${provider}（${info.label || '未知'}）`
}

function providerTitle(account) {
  if (!isOracleAccount(account)) return ''

  const info = oracleAccountTypeInfo(account)
  const parts = [
    info.reason,
    info.homeRegionId ? `Home Region: ${info.homeRegionId}` : '',
    info.checkedAt ? `检测时间: ${fmtDateTime(info.checkedAt)}` : ''
  ]
  return parts.filter(Boolean).join(' · ') || info.label
}

function keepOracleAccountType(accountId, info) {
  if (!accounts.value.some((account) => account.id === accountId)) return
  accounts.value = accounts.value.map((account) => (
    account.id === accountId ? { ...account, oracleAccountType: info } : account
  ))
  oracleAccountTypes.value = {
    ...oracleAccountTypes.value,
    [accountId]: info
  }
}

async function loadMissingOracleAccountTypes() {
  const oracleAccounts = accounts.value.filter((account) => (
    isOracleAccount(account) && !isValidOracleAccountType(account.oracleAccountType)
  ))
  const loadToken = oracleTypeLoadToken.value + 1
  oracleTypeLoadToken.value = loadToken

  oracleAccountTypes.value = Object.fromEntries(oracleAccounts.map((account) => [
    account.id,
    {
      type: 'loading',
      label: '检测中',
      reason: '正在读取 OCI 订阅信息'
    }
  ]))

  await Promise.allSettled(oracleAccounts.map(async (account) => {
    try {
      const response = await accountsApi.oracleAccountType(account.id)
      if (oracleTypeLoadToken.value !== loadToken) return
      keepOracleAccountType(account.id, normalizeOracleAccountType(response.data))
    } catch (error) {
      if (oracleTypeLoadToken.value !== loadToken) return
      keepOracleAccountType(account.id, {
        type: 'unknown',
        label: '未知',
        reason: error.response?.data?.error || error.message
      })
    }
  }))
}

async function toggleAccount(account) {
  const nextEnabled = !isEnabled(account)
  togglingId.value = account.id
  try {
    const response = await accountsApi.update(account.id, { enabled: nextEnabled })
    accounts.value = replaceById(accounts.value, response.data)
    window.$toast?.(nextEnabled ? '账户已启用' : '账户已停用', 'success')
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    togglingId.value = null
  }
}

async function toggleDnsAccount(account) {
  const nextEnabled = !isEnabled(account)
  togglingDnsId.value = account.id
  try {
    const response = await accountsApi.updateDns(account.id, { enabled: nextEnabled })
    dnsAccounts.value = replaceById(dnsAccounts.value, response.data)
    window.$toast?.(nextEnabled ? 'DNS 账户已启用' : 'DNS 账户已停用', 'success')
  } catch (error) {
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    togglingDnsId.value = null
  }
}

function moveItem(items, index, direction) {
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= items.length) return items

  const nextItems = [...items]
  const [item] = nextItems.splice(index, 1)
  nextItems.splice(targetIndex, 0, item)
  return nextItems
}

async function moveAccount(index, direction) {
  const current = accounts.value[index]
  if (!current || sortingId.value) return

  const previous = [...accounts.value]
  const next = moveItem(accounts.value, index, direction)
  if (next === accounts.value) return

  sortingId.value = current.id
  accounts.value = next
  try {
    const response = await accountsApi.reorder(next.map((item) => item.id))
    accounts.value = response.data || next
    window.$toast?.('账户排序已更新', 'success')
  } catch (error) {
    accounts.value = previous
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    sortingId.value = null
  }
}

async function moveDnsAccount(index, direction) {
  const current = dnsAccounts.value[index]
  if (!current || sortingDnsId.value) return

  const previous = [...dnsAccounts.value]
  const next = moveItem(dnsAccounts.value, index, direction)
  if (next === dnsAccounts.value) return

  sortingDnsId.value = current.id
  dnsAccounts.value = next
  try {
    const response = await accountsApi.reorderDns(next.map((item) => item.id))
    dnsAccounts.value = response.data || next
    window.$toast?.('DNS 账户排序已更新', 'success')
  } catch (error) {
    dnsAccounts.value = previous
    window.$toast?.(error.response?.data?.error || error.message, 'error')
  } finally {
    sortingDnsId.value = null
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
  if (account.dnsProvider === 'tencentcloud') {
    return `${maskKey(account.credentials?.secretId)} · ${account.credentials?.domainName || '-'}`
  }
  if (account.dnsProvider === 'huaweicloud') {
    return `${maskKey(account.credentials?.accessKeyId)} · ${account.credentials?.domainName || '-'}`
  }
  return '-'
}

function validateDnsCredentials(provider, credentials) {
  if (provider === 'cloudflare') {
    if (!credentials.apiToken || !credentials.zoneId) {
      return '请填写 API Token 和 Zone ID'
    }
    if (!credentials.domainName) {
      return '请填写根域名，例如 example.com'
    }
    return ''
  }

  if (provider === 'aliyun') {
    if (!credentials.accessKeyId || !credentials.accessKeySecret) {
      return '请填写 Access Key ID 和 Access Key Secret'
    }
    if (!credentials.domainName) {
      return '请填写根域名，例如 frp.gs'
    }
    return ''
  }

  if (provider === 'tencentcloud') {
    if (!credentials.secretId || !credentials.secretKey) {
      return '请填写 SecretId 和 SecretKey'
    }
    if (!credentials.domainName) {
      return '请填写根域名，例如 example.com'
    }
    return ''
  }

  if (provider === 'huaweicloud') {
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      return '请填写 Access Key ID (AK) 和 Secret Access Key (SK)'
    }
    if (!credentials.domainName) {
      return '请填写根域名，例如 example.com'
    }
    return ''
  }

  return ''
}

function dnsProviderLabel(provider) {
  return DNS_PROVIDER_LABELS[provider] || String(provider || '-').toUpperCase()
}

function fmtDate(value) {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '-'
}

function fmtDateTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
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

.sort-actions {
  display: flex;
  gap: 6px;
  flex-wrap: nowrap;
}

.sort-button {
  width: 32px;
  min-width: 32px;
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}

.summary-cell {
  font-size: 11px;
  color: var(--text-muted);
}

.status-toggle {
  border: 0;
  cursor: pointer;
}

.status-toggle:disabled {
  cursor: wait;
  opacity: 0.7;
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
