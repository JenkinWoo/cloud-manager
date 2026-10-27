import axios from 'axios'
import { createHash, randomUUID } from 'node:crypto'
import { billingNumber, billingTotals, groupBillingRows } from '../../utils/billing.mjs'
import BaseComputeProvider from './BaseComputeProvider.mjs'
import { normalizeAzureCredentials } from '../../utils/azureCredentials.mjs'
import { isAzureResourceGroupLocationError, withAzureNetworkRetry } from '../../utils/azureRequest.mjs'
import { getAzureVmQuota } from '../../utils/azureVmQuota.mjs'
import { getAzurePublicIpQuota } from '../../utils/azurePublicIpQuota.mjs'
import { getAzureFreeBenefits, azureFreeAllocationReason } from '../../utils/azureFreeBenefits.mjs'
import { AZURE_COST_POLICY, AZURE_FREE_VM_PROFILES, getAzureFreeVmProfile, validateAzureFreeCreateParams,
  assertAzureFreeSubscription, azureFreeOnlyError, withAzureAllocationLock } from '../../utils/azureCostPolicy.mjs'

let azureSdkPromise = null
const azureBillingCache = new Map()
const azureVmChargeCache = new Map()
const AZURE_MONITOR_METRICS_API_VERSION = '2018-01-01'
const DISPLAY_NAME_TAG = 'cloud-manager-display-name'
const VM_RESOURCE_PROVIDERS = ['Microsoft.Network', 'Microsoft.Compute']
const PROVIDER_REGISTRATION_TIMEOUT_MS = 120000
const PROVIDER_REGISTRATION_POLL_MS = 5000
const AZURE_FREE_TIER_VM_SIZES = new Set(Object.keys(AZURE_FREE_VM_PROFILES))

function safeName(input, fallback = 'cloud-manager') {
  const cleaned = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return (cleaned || fallback).slice(0, 50)
}

function parseAzureResourceId(id = '') {
  const parts = String(id).split('/').filter(Boolean)
  const mapped = {}

  for (let i = 0; i < parts.length - 1; i += 2) {
    mapped[parts[i].toLowerCase()] = parts[i + 1]
  }

  return {
    subscriptionId: mapped.subscriptions || '',
    resourceGroup: mapped.resourcegroups || '',
    provider: mapped.providers || '',
    resourceName: parts[parts.length - 1] || '',
    resourceType: parts[parts.length - 2] || '',
    parts
  }
}

function mapPowerState(statuses = []) {
  const powerStatus = statuses.find((item) => item.code?.startsWith('PowerState/'))?.code?.split('/')[1]
  const provisioningStatus = statuses.find((item) => item.code?.startsWith('ProvisioningState/'))?.code?.split('/')[1]

  const stateMap = {
    running: 'RUNNING',
    starting: 'STARTING',
    stopped: 'STOPPED',
    stopping: 'STOPPING',
    deallocated: 'STOPPED',
    deallocating: 'STOPPING',
    unknown: 'UNKNOWN'
  }

  if (powerStatus) return stateMap[powerStatus.toLowerCase()] || powerStatus.toUpperCase()
  if (provisioningStatus) return provisioningStatus.toUpperCase()
  return 'UNKNOWN'
}

function capabilityValue(sku, key) {
  return sku.capabilities?.find((item) => item.name === key)?.value || ''
}

function isStudentFreeSubscription(subscription = {}) {
  const name = String(subscription.displayName || '').toLowerCase()
  const quotaId = String(subscription.subscriptionPolicies?.quotaId || '').toLowerCase()
  const spendingLimit = String(subscription.subscriptionPolicies?.spendingLimit || '').toLowerCase()
  const text = `${name} ${quotaId} ${spendingLimit}`

  return (
    text.includes('student') ||
    text.includes('students') ||
    text.includes('free') ||
    text.includes('trial') ||
    text.includes('azure for students') ||
    quotaId.includes('student') ||
    quotaId.includes('free') ||
    quotaId.includes('trial') ||
    spendingLimit === 'on'
  )
}

function parseCostQuery(result = {}) {
  const columns = Array.isArray(result.properties?.columns) ? result.properties.columns : []
  const rows = Array.isArray(result.properties?.rows) ? result.properties.rows : []
  const index = (name) => columns.findIndex((column) => column.name === name)
  const costIndex = index('PreTaxCost')
  const currencyIndex = index('Currency')
  const total = rows.reduce((sum, row) => sum + (Number(row[costIndex]) || 0), 0)
  return {
    amount: total,
    currency: rows.find((row) => row[currencyIndex])?.[currencyIndex] || 'USD',
    rows: rows.map((row) => Object.fromEntries(columns.map((column, columnIndex) => [column.name, row[columnIndex]])))
  }
}

function parseBillingProfileId(value = '') {
  const match = String(value).match(/\/billingAccounts\/([^/]+)\/billingProfiles\/([^/]+)/i)
  return match ? { billingAccountName: match[1], billingProfileName: match[2] } : null
}

async function loadAzureSdk() {
  if (!azureSdkPromise) {
    azureSdkPromise = Promise.all([
      import('@azure/identity'),
      import('@azure/arm-compute'),
      import('@azure/arm-network'),
      import('@azure/arm-resources')
    ]).then(([identityMod, computeMod, networkMod, resourcesMod]) => ({
      ClientSecretCredential: identityMod.ClientSecretCredential,
      ComputeManagementClient: computeMod.ComputeManagementClient,
      NetworkManagementClient: networkMod.NetworkManagementClient,
      ResourceManagementClient: resourcesMod.ResourceManagementClient
    }))
  }

  return azureSdkPromise
}

export default class AzureProvider extends BaseComputeProvider {
  static providerName = 'azure'
  static get capabilities() {
    return [
      'allow_all_inbound_traffic',
      'rename_instance',
      'manage_public_ips',
      'bind_public_ip'
    ]
  }

  constructor(account) {
    super(account)
    this.accountName = account.name || 'azure'
    this.credentials = normalizeAzureCredentials(account.credentials || {})
    this.credential = null
    this.subscriptionId = null
    this.subscriptionName = null
    this.computeClient = null
    this.networkClient = null
    this.resourceClient = null
    this.selectedSubscriptionId = null
    this._sdk = null
    this._credentialPromise = null
    this._initPromise = null
  }

  useSubscription(subscriptionId) {
    const nextSubscriptionId = subscriptionId || null
    if (this.selectedSubscriptionId !== nextSubscriptionId) {
      this.selectedSubscriptionId = nextSubscriptionId
      this.subscriptionId = null
      this.subscriptionName = null
      this.computeClient = null
      this.networkClient = null
      this.resourceClient = null
      this._initPromise = null
    }
    return this
  }

  async _loadSdk() {
    if (!this._sdk) {
      this._sdk = await loadAzureSdk()
    }
    return this._sdk
  }

  async _ensureCredential() {
    if (this.credential) return this.credential
    if (this._credentialPromise) return this._credentialPromise

    this._credentialPromise = (async () => {
      const { ClientSecretCredential } = await this._loadSdk()
      this.credential = new ClientSecretCredential(
        this.credentials.tenant,
        this.credentials.appId,
        this.credentials.password
      )
      return this.credential
    })()

    return this._credentialPromise
  }

  async _armGet(path, apiVersion = '2022-12-01') {
    await this._ensureCredential()
    const token = await this.credential.getToken('https://management.azure.com/.default')
    if (!token?.token) {
      throw new Error('无法获取 Azure 管理 API 访问令牌')
    }

    const url = `https://management.azure.com${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`
    const response = await axios.get(url, {
      timeout: 25000,
      headers: {
        Authorization: `Bearer ${token.token}`
      }
    })
    return response.data
  }

  async _getArmToken() {
    await this._ensureCredential()
    const token = await this.credential.getToken('https://management.azure.com/.default')
    if (!token?.token) {
      throw new Error('无法获取 Azure 管理 API 访问令牌')
    }
    return token.token
  }

  async _listSubscriptions() {
    const response = await this._armGet('/subscriptions', '2020-01-01')
    return Array.isArray(response?.value) ? response.value : []
  }

  async listEligibleSubscriptions() {
    const subscriptions = await this._listSubscriptions()
    return subscriptions
      .filter((item) => String(item.state || '').toLowerCase() === 'enabled')
      .filter((item) => isStudentFreeSubscription(item))
      .map((item) => ({
        subscriptionId: item.subscriptionId,
        displayName: item.displayName || item.subscriptionId,
        quotaId: item.subscriptionPolicies?.quotaId || '',
        spendingLimit: item.subscriptionPolicies?.spendingLimit || ''
      }))
  }

  async _armPost(path, body, apiVersion) {
    await this._ensureCredential()
    const token = await this._getArmToken()
    const url = `https://management.azure.com${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await axios.post(url, body, {
          timeout: 30000,
          headers: { Authorization: `Bearer ${token}` }
        })
        return response.data
      } catch (error) {
        if (error.response?.status !== 429 || attempt >= 2) throw error
        const retryAfter = Number(error.response.headers?.['retry-after'])
        const delay = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter * 1000, 500), 5000) : (attempt + 1) * 1500
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  async getSubscriptionBilling(subscriptionId) {
    const cacheKey = `${this.accountName}:${subscriptionId}`
    const cached = azureBillingCache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAt < 60000) return structuredClone(cached.value)
    const subscription = (await this._listSubscriptions()).find((item) => item.subscriptionId === subscriptionId)
    if (!subscription || String(subscription.state || '').toLowerCase() !== 'enabled') {
      throw Object.assign(new Error('所选 Azure 订阅不可用或当前账号无权限访问'), { statusCode: 400 })
    }

    const now = new Date()
    const monthFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const billing = {
      subscriptionId,
      displayName: subscription.displayName || subscriptionId,
      subscriptionState: subscription.state,
      quotaId: subscription.subscriptionPolicies?.quotaId || '',
      spendingLimit: subscription.subscriptionPolicies?.spendingLimit || '',
      checkedAt: now.toISOString(),
      currentMonth: null,
      credit: null,
      officialBalance: null,
      errors: []
    }

    try {
      const result = await this._armGet(`/subscriptions/${subscriptionId}/providers/Microsoft.Billing/billingProperty/default`, '2024-04-01')
      const properties = result.properties || {}
      const period = properties.billingProfileSpendingLimitDetails?.find((item) => item.status === 'Active') ||
        properties.billingProfileSpendingLimitDetails?.[0]
      billing.credit = period ? {
        type: period.type || 'AzureForStudents',
        amount: Number(period.amount),
        currency: period.currency || properties.billingCurrency || 'USD',
        startDate: period.startDate || null,
        endDate: period.endDate || null,
        status: period.status || 'Unknown'
      } : null
      billing.billingStatus = properties.subscriptionBillingStatus || properties.billingProfileStatus || null
      billing.subscriptionBillingType = properties.subscriptionBillingType || null
      const profile = parseBillingProfileId(properties.billingProfileId)
      if (profile) {
        try {
          const balance = await this._armGet(
            `/providers/Microsoft.Billing/billingAccounts/${profile.billingAccountName}/billingProfiles/${profile.billingProfileName}/availableBalance/default`,
            '2020-05-01'
          )
          billing.officialBalance = balance.properties?.amount || null
        } catch (error) {
          billing.errors.push({ source: 'officialBalance', message: error.response?.data?.error?.message || error.message, status: error.response?.status })
        }
      }
    } catch (error) {
      billing.errors.push({ source: 'billingProperty', message: error.response?.data?.error?.message || error.message, status: error.response?.status })
    }

    const query = (timePeriod) => ({
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod,
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
        grouping: [{ type: 'Dimension', name: 'ServiceName' }]
      }
    })
    try {
      const result = await this._armPost(
        `/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query`,
        query({ from: monthFrom, to: now.toISOString() }),
        '2025-03-01'
      )
      billing.currentMonth = parseCostQuery(result)
    } catch (error) {
      billing.errors.push({ source: 'currentMonth', message: error.response?.data?.error?.message || error.message, status: error.response?.status })
    }

    if (billing.credit?.startDate) {
      try {
        const result = await this._armPost(
          `/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query`,
          query({ from: billing.credit.startDate, to: now.toISOString() }),
          '2025-03-01'
        )
        billing.credit.used = parseCostQuery(result)
        if (Number.isFinite(billing.credit.amount) && Number.isFinite(billing.credit.used.amount)) {
          billing.credit.referenceRemaining = Math.max(0, billing.credit.amount - billing.credit.used.amount)
        }
      } catch (error) {
        billing.errors.push({ source: 'creditUsed', message: error.response?.data?.error?.message || error.message, status: error.response?.status })
      }
    }
    billing.hasBillingData = Boolean(billing.currentMonth || billing.credit || billing.officialBalance)
    if (billing.hasBillingData) azureBillingCache.set(cacheKey, { cachedAt: Date.now(), value: billing })
    return billing
  }

  async _billingArmGet(path, apiVersion) {
    return withAzureNetworkRetry('读取账单', () => this._armGet(path, apiVersion))
  }

  async _billingNextPage(nextLink) {
    const url = new URL(nextLink, 'https://management.azure.com')
    if (url.origin !== 'https://management.azure.com') throw new Error('Azure 返回了无效的账单分页地址')
    const version = url.searchParams.get('api-version') || '2024-08-01'
    url.searchParams.delete('api-version')
    return this._billingArmGet(url.pathname + url.search, version)
  }

  async _getUsageBilling(subscriptionId, { from, to }) {
    const end = new Date(Math.min(new Date(to).getTime() - 1, Date.now()))
    const filter = "properties/usageStart ge '" + from.slice(0, 10) + "' and properties/usageEnd le '" + end.toISOString().slice(0, 10) + "'"
    let response = await this._billingArmGet('/subscriptions/' + subscriptionId + '/providers/Microsoft.Consumption/usageDetails?$top=1000&$expand=meterDetails&$filter=' + encodeURIComponent(filter), '2024-08-01')
    const rows = []
    const seen = new Set()
    while (true) {
      if (!Array.isArray(response.value)) throw new Error('Azure 未返回用量明细列表')
      for (const item of response.value) {
        const p = item.properties || {}
        const meter = p.meterDetails || {}
        const date = p.date || p.usageStart
        // The legacy endpoint may return records outside the requested month.
        if (date && (new Date(date) < new Date(from) || new Date(date) >= new Date(to))) continue
        const amount = billingNumber(p.costInBillingCurrency ?? p.pretaxCost)
        if (amount === null) throw new Error('Azure 用量明细缺少计费金额')
        rows.push({
          service: p.meterCategory || meter.meterCategory || p.consumedService || '未知服务',
          meter: p.meterName || meter.meterName || p.product || '',
          resource: p.resourceId || p.instanceName || p.resourceName || '',
          region: p.resourceLocation || p.instanceLocation || meter.meterLocation || '',
          amount, currency: p.billingCurrencyCode || p.billingCurrency || p.currency || '',
          usage: billingNumber(p.quantity), unit: p.unitOfMeasure || meter.unitOfMeasure || '',
          unitPrice: billingNumber(p.effectivePrice ?? p.unitPrice), chargeType: p.chargeType || '',
          periodStart: date || '', periodEnd: p.date || p.usageEnd || date || ''
        })
      }
      if (!response.nextLink) break
      if (seen.has(response.nextLink)) throw new Error('Azure 账单分页重复，请稍后重试')
      seen.add(response.nextLink)
      response = await this._billingNextPage(response.nextLink)
    }
    const services = groupBillingRows(rows)
    return { services, ...billingTotals(services) }
  }

  async getBilling(options = {}) {
    const subscriptions = []
    let response = await this._billingArmGet('/subscriptions', '2020-01-01')
    const seen = new Set()
    while (true) {
      if (!Array.isArray(response.value)) throw new Error('Azure 未返回订阅列表')
      subscriptions.push(...response.value)
      if (!response.nextLink) break
      if (seen.has(response.nextLink)) throw new Error('Azure 订阅分页重复')
      seen.add(response.nextLink)
      response = await this._billingNextPage(response.nextLink)
    }
    const results = []
    // Query only this account's subscriptions; preserve successful results if one fails.
    for (const subscription of subscriptions) {
      const base = { subscriptionId: subscription.subscriptionId, subscriptionName: subscription.displayName || subscription.subscriptionId }
      try {
        results.push({ ...base, status: 'ok', ...await this._getUsageBilling(subscription.subscriptionId, options) })
      } catch (error) {
        results.push({ ...base, status: 'error', total: null, totals: [], services: [], error: error.cause?.response?.data?.error?.message || error.response?.data?.error?.message || error.message })
      }
    }
    const services = results.flatMap(item => item.services.map(row => ({ ...row, subscriptionName: item.subscriptionName })))
    const failures = results.filter(item => item.status === 'error')
    return {
      provider: 'azure', status: failures.length ? (failures.length === results.length ? 'error' : 'partial') : 'ok',
      ...billingTotals(services), ...(failures.length ? { total: null } : {}),
      error: failures.map(item => item.subscriptionName + '：' + item.error).join('；'),
      subscriptions: results, services, checkedAt: new Date().toISOString()
    }
  }

  async _resolveSubscription(requestedSubscriptionId = this.selectedSubscriptionId) {
    const subscriptions = await this._listSubscriptions()
    const enabledSubscriptions = subscriptions.filter((item) => String(item.state || '').toLowerCase() === 'enabled')

    if (requestedSubscriptionId) {
      const selected = enabledSubscriptions.find((item) => item.subscriptionId === requestedSubscriptionId)
      if (!selected) {
        throw new Error('所选 Azure 订阅不可用或当前账号无权限访问')
      }
      return selected
    }

    const preferred = enabledSubscriptions.find((item) => isStudentFreeSubscription(item))
    if (preferred) return preferred

    const firstEnabled = enabledSubscriptions[0]
    if (!firstEnabled) {
      throw new Error('当前 Azure 服务主体没有可用订阅，请确认已给该 appId 分配订阅权限')
    }

    return firstEnabled
  }

  async _ensureInitialized() {
    if (this._initPromise) {
      await this._initPromise
      return
    }

    this._initPromise = (async () => {
      const { ComputeManagementClient, NetworkManagementClient, ResourceManagementClient } = await this._loadSdk()
      await this._ensureCredential()

      const subscription = await this._resolveSubscription()
      this.subscriptionId = subscription.subscriptionId
      this.subscriptionName = subscription.displayName || subscription.subscriptionId
      this.subscription = subscription

      this.computeClient = new ComputeManagementClient(this.credential, this.subscriptionId)
      this.networkClient = new NetworkManagementClient(this.credential, this.subscriptionId)
      this.resourceClient = new ResourceManagementClient(this.credential, this.subscriptionId)
    })()

    try {
      await this._initPromise
    } catch (error) {
      this._initPromise = null
      throw error
    }
  }

  async _ensureResourceProvidersRegistered() {
    await this._ensureInitialized()
    // Registration is subscription-scoped. Check on every creation attempt so
    // retries and subscription changes never reuse another subscription's state.
    const { providers } = this.resourceClient
    for (const namespace of VM_RESOURCE_PROVIDERS) {
      try {
        let provider = await providers.get(namespace)
        if (provider.registrationState === 'Registered') continue
        if (provider.registrationState !== 'Registering') {
          provider = await providers.register(namespace)
        }

        const deadline = Date.now() + PROVIDER_REGISTRATION_TIMEOUT_MS
        while (provider.registrationState !== 'Registered') {
          if (Date.now() >= deadline) {
            throw new Error(`Azure 订阅 ${this.subscriptionId} 的 ${namespace} 仍在注册中，稍后将自动检查注册状态`)
          }
          await new Promise((resolve) => setTimeout(resolve, PROVIDER_REGISTRATION_POLL_MS))
          provider = await providers.get(namespace)
        }
      } catch (error) {
        if ([401, 403].includes(error.statusCode) || ['AuthorizationFailed', 'AuthenticationFailed'].includes(error.code)) {
          const registrationError = new Error(
            `无法检查或注册 Azure 订阅 ${this.subscriptionId} 的资源提供程序 ${namespace}：权限不足。` +
            `请让订阅管理员在 Azure 门户“订阅 → 资源提供程序”中注册 Microsoft.Network 和 Microsoft.Compute，` +
            `并确认当前服务主体具备订阅读取和创建资源权限。原始错误：${error.message}`,
            { cause: error }
          )
          registrationError.retryable = false
          throw registrationError
        }
        throw error
      }
    }
  }

  async _getAllowedLocations(subscriptionId) {
    let assignment
    try {
      assignment = await this._armGet(
        `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policyAssignments/sys.regionrestriction`,
        '2022-06-01'
      )
    } catch (error) {
      // A subscription without this assignment has no sys.regionrestriction filter.
      if (error.response?.status === 404) return null
      throw error
    }

    const allowedLocations = assignment?.properties?.parameters?.listOfAllowedLocations?.value
    if (!Array.isArray(allowedLocations) || allowedLocations.some((name) => typeof name !== 'string')) {
      throw new Error('Azure 区域限制策略 sys.regionrestriction 缺少有效的 listOfAllowedLocations 参数')
    }

    return new Set(allowedLocations.map((name) => name.trim().toLowerCase()))
  }

  async listLocations(subscriptionId) {
    const subscription = await this._resolveSubscription(subscriptionId)
    const [response, allowedLocations] = await Promise.all([
      this._armGet(`/subscriptions/${subscription.subscriptionId}/locations`, '2022-12-01'),
      this._getAllowedLocations(subscription.subscriptionId)
    ])
    const locations = Array.isArray(response?.value) ? response.value : []

    return locations
      .filter((item) => allowedLocations === null || allowedLocations.has(String(item.name).toLowerCase()))
      .map((item) => ({
        name: item.name,
        displayName: item.displayName || item.name,
        regionalDisplayName: item.regionalDisplayName || item.displayName || item.name
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  static isVmSkuInRegion(sku, location) {
    const region = String(location).toLowerCase()
    const locations = [...(sku.locations || []), ...(sku.locationInfo || []).map((item) => item.location).filter(Boolean)]
    return sku.resourceType?.toLowerCase() === 'virtualmachines' && locations.some((item) => item.toLowerCase() === region)
  }

  static isVmSkuAvailable(sku, location) {
    const region = String(location).toLowerCase()
    if (!AzureProvider.isVmSkuInRegion(sku, region)) return false
    return !(sku.restrictions || []).some((restriction) => {
      // A zonal restriction alone does not forbid our deployments without a zone.
      if (restriction.type?.toLowerCase() !== 'location') return false
      const locations = restriction.restrictionInfo?.locations?.length
        ? restriction.restrictionInfo.locations : restriction.values || []
      return !locations.length || locations.some((item) => item.toLowerCase() === region)
    })
  }

  async _listRegionalVmSkus(client, location, options = {}) {
    const region = String(location || '').trim().toLowerCase()
    if (!/^[a-z0-9]+$/.test(region)) {
      throw Object.assign(new Error('Azure 区域名称无效'), { retryable: false })
    }
    const skus = []
    for await (const sku of client.resourceSkus.list({ ...options, filter: `location eq '${region}'` })) {
      if (AzureProvider.isVmSkuInRegion(sku, region)) skus.push(sku)
    }
    return skus
  }

  async _listAvailableVmSkus(client, location) {
    return (await this._listRegionalVmSkus(client, location)).filter((sku) => AzureProvider.isVmSkuAvailable(sku, location))
  }

  async _listCpuUsage(client, location, options = {}) {
    return withAzureNetworkRetry('查询 CPU 配额', async () => {
      const usages = []
      for await (const usage of client.usageOperations.list(location, options)) usages.push(usage)
      return usages
    })
  }

  async _assertVmSizeAvailable(location, vmSize) {
    const skus = await this._listAvailableVmSkus(this.computeClient, location)
    const sku = skus.find((sku) => sku.name?.toLowerCase() === vmSize.toLowerCase())
    if (!sku) {
      throw Object.assign(new Error(`当前订阅在 ${location} 无法使用规格 ${vmSize}，请更换规格或区域`), {
        code: 'SkuNotAvailable', retryable: false
      })
    }
    const quota = getAzureVmQuota(sku, await this._listCpuUsage(this.computeClient, location))
    if (quota.sufficient !== true) {
      throw Object.assign(new Error(`${location} / ${vmSize}：${quota.reason}`), {
        code: quota.sufficient === false ? 'QuotaExceeded' : 'QuotaInformationUnavailable', retryable: false
      })
    }
    if (capabilityValue(sku, 'PremiumIO').toLowerCase() !== 'true') {
      throw azureFreeOnlyError('此规格不支持 P6 系统盘，请选择支持 Premium SSD 的规格')
    }
    return sku
  }

  async listVmSizes(location, subscriptionId) {
    if (!location) {
      throw new Error('Azure VM Size 查询需要 location')
    }

    this.useSubscription(subscriptionId)
    await this._ensureInitialized()
    assertAzureFreeSubscription(this.subscription)
    const [sizes, state] = await Promise.all([
      this._listVmSizes(this.computeClient, location), this._getFreeCreateState()
    ])
    await this._assertLocationAllowed(location)
    return this._applyFreeCreateState(sizes, location, state)
  }

  async _getFreeCreateState() {
    const now = new Date()
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
    const inventory = { vms: [], disks: [] }
    const [billing] = await Promise.all([
      this._getUsageBilling(this.subscriptionId, { from, to }),
      (async () => { for await (const vm of this.computeClient.virtualMachines.listAll()) inventory.vms.push(vm) })(),
      (async () => { for await (const disk of this.computeClient.disks.list()) inventory.disks.push(disk) })()
    ])
    if (!Array.isArray(billing.services)) throw azureFreeOnlyError('无法读取免费资源的本月用量，禁止创建')
    return { benefit: getAzureFreeBenefits(billing.services), inventory, rows: billing.services, now }
  }

  _applyFreeCreateState(sizes, location, state, exclusions = {}) {
    return sizes.map(size => {
      const reason = azureFreeAllocationReason({ ...state, ...exclusions, location, vmSize: size.name })
      return { ...size, freeEligible: !reason, available: size.available === true && !reason,
        restrictionReason: reason || size.restrictionReason, osDisk: AZURE_COST_POLICY.osDisk }
    })
  }

  // Used by the HTTP route before queueing and again by the worker. Client
  // flags, requested defaults and stale recommendations cannot grant benefits.
  async prepareFreeCreate(params = {}) {
    validateAzureFreeCreateParams(params)
    if (typeof params.subscriptionId !== 'string' || !params.subscriptionId.trim()) {
      throw Object.assign(new Error('请选择 Azure 订阅'), { statusCode: 400, retryable: false })
    }
    this.useSubscription(params.subscriptionId.trim())
    await this._ensureInitialized()
    assertAzureFreeSubscription(this.subscription)
    if (!params.location || !params.vmSize) {
      const result = await this.listCreateOptions(this.subscriptionId)
      const option = result.options.find(item => (!params.location || item.location === params.location.toLowerCase()) &&
        (!params.vmSize || item.vmSize === params.vmSize))
      if (!option) throw azureFreeOnlyError('当前订阅没有通过账单免费记录、用量和配额检查的组合，请查看创建页面中的具体原因')
      const selected = { ...params, subscriptionId: this.subscriptionId, location: option.location, vmSize: option.vmSize }
      validateAzureFreeCreateParams(selected)
      return selected
    }
    const location = String(params.location).trim().toLowerCase()
    const state = await this._getFreeCreateState()
    const reason = azureFreeAllocationReason({ ...state, location, vmSize: params.vmSize })
    if (reason) throw azureFreeOnlyError(reason)
    await this._assertLocationAllowed(location)
    await this._assertVmSizeAvailable(location, params.vmSize)
    return { ...params, subscriptionId: this.subscriptionId, location }
  }

  async _getFreeVmCharges(subscriptionId, refresh = false) {
    const now = new Date()
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
    const key = `${this.credentials.tenant}/${this.credentials.appId}/${subscriptionId}/${from}`
    const cached = azureVmChargeCache.get(key)
    if (!refresh && cached && Date.now() - cached.at < 60000) return cached.charges
    try {
      const result = await this._getUsageBilling(subscriptionId, { from, to })
      const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const charges = result.services.filter(row => row.amount > 0 && /virtual machines|microsoft.compute/i.test(row.service))
        .flatMap(row => [...AZURE_FREE_TIER_VM_SIZES].filter(size => normalize(row.meter) === normalize(size.replace('Standard_', '')))
          .map(vmSize => ({ vmSize, location: normalize(row.region) })))
      azureVmChargeCache.set(key, { at: Date.now(), charges })
      return charges
    } catch (error) {
      throw Object.assign(new Error(`无法检查本月虚拟机计费记录，请刷新后重试：${error.message}`), { retryable: false })
    }
  }

  _applyVmCharges(sizes, location, charges) {
    return sizes.map(size => charges.some(row => row.vmSize === size.name && row.location === location.toLowerCase())
      ? { ...size, available: false, restrictionReason: '本月此区域和规格已有实际计算费用，免费模式不允许继续创建' }
      : size)
  }

  async _listVmSizes(client, location, options = {}) {
    const [regionalSkus, usages] = await Promise.all([
      this._listRegionalVmSkus(client, location, options), this._listCpuUsage(client, location, options)
    ])
    const sizes = []

    // Resource SKUs is the subscription-specific source. Intersecting it with
    // the legacy VM sizes endpoint can drop current-generation VM sizes.
    for (const item of regionalSkus) {
      if (!AZURE_FREE_TIER_VM_SIZES.has(item.name)) continue
      const profile = getAzureFreeVmProfile(item.name)
      const architecture = capabilityValue(item, 'CpuArchitectureType') || profile.architecture
      if (architecture.toLowerCase() !== profile.architecture.toLowerCase()) continue
      const generations = capabilityValue(item, 'HyperVGenerations')
      if (generations && !generations.split(',').some((value) => value.trim().toUpperCase() === 'V2')) continue
      const numberOfCores = Number(capabilityValue(item, 'vCPUs')) || null
      const memoryGb = Number(capabilityValue(item, 'MemoryGB')) || null
      const regionAvailable = AzureProvider.isVmSkuAvailable(item, location)
      const quota = getAzureVmQuota(item, usages)
      const premiumDiskSupported = capabilityValue(item, 'PremiumIO').toLowerCase() === 'true'
      const available = regionAvailable && quota.sufficient === true && premiumDiskSupported
      sizes.push({
        name: item.name,
        numberOfCores,
        memoryInMB: memoryGb === null ? null : memoryGb * 1024,
        available,
        family: item.family,
        quota,
        freeTierCandidate: true,
        architecture: profile.architecture,
        restrictionReason: !regionAvailable ? '当前订阅在此区域受限' : !premiumDiskSupported ? '不支持 P6 系统盘' : quota.reason,
        label: `${item.name} · ${profile.architecture} · ${numberOfCores ?? '?'} vCPU · ${memoryGb ?? '?'} GB`
      })
    }

    return sizes.sort((a, b) => Number(b.freeTierCandidate) - Number(a.freeTierCandidate) ||
      (a.numberOfCores ?? Infinity) - (b.numberOfCores ?? Infinity) || String(a.name).localeCompare(String(b.name)))
  }

  async _listNetworkUsage(client, location, options = {}) {
    return withAzureNetworkRetry('查询公网 IP 配额', async () => {
      const usages = []
      for await (const usage of client.usages.list(location, options)) usages.push(usage)
      return usages
    })
  }

  async listCreateOptions(subscriptionId) {
    if (typeof subscriptionId !== 'string' || !subscriptionId.trim()) {
      throw Object.assign(new Error('请选择 Azure 订阅'), { statusCode: 400 })
    }
    this.useSubscription(subscriptionId.trim())
    await this._ensureInitialized()
    assertAzureFreeSubscription(this.subscription)
    const [allLocations, state] = await Promise.all([
      this.listLocations(this.subscriptionId), this._getFreeCreateState()
    ])
    const locations = allLocations
    const regions = []
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(3, locations.length) }, async () => {
      while (cursor < locations.length) {
        const location = locations[cursor++]
        if (!state.benefit.vmRegions.some(item => item.location === location.name.toLowerCase()) ||
            !state.benefit.diskRegions.includes(location.name.toLowerCase())) {
          const sizes = this._applyFreeCreateState(Object.keys(AZURE_FREE_VM_PROFILES).map(name => ({ name, available: false })), location.name, state)
          regions.push({ location: location.name, displayName: location.displayName, sizes, status: 'blocked', reason: '' })
          continue
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30000)
        try {
          const sizes = this._applyFreeCreateState(await this._listVmSizes(this.computeClient, location.name, { abortSignal: controller.signal }), location.name, state)
          regions.push({ location: location.name, displayName: location.displayName, sizes,
            status: sizes.some(size => size.available) ? 'ready' : 'blocked',
            reason: sizes.length ? '' : '此区域没有可用的免费额度规格' })
        } catch (error) {
          regions.push({ location: location.name, displayName: location.displayName, sizes: [], status: 'unknown',
            reason: controller.signal.aborted ? '区域查询超时，请刷新重试' : error.message })
        } finally { clearTimeout(timer) }
      }
    }))
    regions.sort((a, b) => a.location.localeCompare(b.location))
    const options = regions.flatMap(region => region.sizes.filter(size => size.available).map(size => ({
      location: region.location, displayName: region.displayName, vmSize: size.name, architecture: size.architecture,
      numberOfCores: size.numberOfCores, memoryInMB: size.memoryInMB, cpuQuota: size.quota,
      osDisk: AZURE_COST_POLICY.osDisk
    })))
    const priority = ['Standard_B2ats_v2', 'Standard_B2pts_v2', 'Standard_B1s']
    options.sort((a, b) => priority.indexOf(a.vmSize) - priority.indexOf(b.vmSize) || a.location.localeCompare(b.location))
    return { subscriptionId: this.subscriptionId, checkedAt: new Date().toISOString(), options, regions,
      benefit: { source: state.benefit.source, monthlyVmHours: state.benefit.monthlyVmHours, monthlyP6Disks: state.benefit.monthlyP6Disks },
      costPolicy: { ...AZURE_COST_POLICY, creationAllowed: options.length > 0 } }
  }

  async _assertLocationAllowed(location) {
    const allowed = await this._getAllowedLocations(this.subscriptionId)
    if (allowed !== null && !allowed.has(String(location).toLowerCase())) {
      throw Object.assign(new Error(`当前订阅的区域策略不允许在 ${location} 创建资源，请刷新推荐组合`), {
        code: 'RequestDisallowedByPolicy', retryable: false
      })
    }
  }

  async _assertPublicIpCapacity(location, publicIpName, vmName) {
    let existing
    try {
      existing = await this.networkClient.publicIPAddresses.get(this._defaultResourceGroupName(), publicIpName)
    } catch (error) {
      if (error.statusCode !== 404) throw error
    }
    if (existing) {
      if (existing.location?.toLowerCase() !== location.toLowerCase() || existing.sku?.name !== 'Standard' ||
          existing.publicIPAddressVersion !== 'IPv4' || existing.publicIPAllocationMethod !== 'Static' ||
          (existing.sku?.tier && existing.sku.tier !== 'Regional') ||
          existing.tags?.managedBy !== 'cloud-manager' || existing.tags?.vmName !== vmName) {
        throw Object.assign(new Error('同名公网 IP 与当前创建任务不匹配，无法复用'), { retryable: false })
      }
      if (existing.provisioningState !== 'Succeeded') {
        throw Object.assign(new Error(`任务公网 IP 状态为 ${existing.provisioningState}，暂时无法复用`), {
          retryable: existing.provisioningState !== 'Failed'
        })
      }
      // This task's allocated address is already counted by Azure.
      return existing
    }
    const quota = getAzurePublicIpQuota(await this._listNetworkUsage(this.networkClient, location))
    if (quota.sufficient !== true) {
      throw Object.assign(new Error(`${location}：${quota.reason}`), {
        code: quota.sufficient === false ? 'PublicIPCountLimitReached' : 'QuotaInformationUnavailable', retryable: false
      })
    }
    return null
  }

  _publicIpName(vmId) {
    return `cm-${createHash('sha256').update(vmId.toLowerCase()).digest('hex').slice(0, 32)}-pip`
  }

  async _ensureVmPublicIp(location, vmName, vmId, zones) {
    const name = this._publicIpName(vmId)
    const existing = await withAzureNetworkRetry('检查公网 IP 配额和已有地址', () => this._assertPublicIpCapacity(location, name, vmName))
    if (existing) return existing
    return withAzureNetworkRetry('创建收费静态公网 IPv4', () => this.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(
      this._defaultResourceGroupName(), name, {
        location, ...(zones?.length ? { zones } : {}),
        tags: { managedBy: 'cloud-manager', vmName },
        sku: { name: 'Standard', tier: 'Regional' }, publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4'
      }))
  }

  async createPublicIp({ location, requestId } = {}) {
    if (typeof location !== 'string' || !/^[a-z0-9]{2,64}$/.test(location) ||
        typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) {
      throw Object.assign(new Error('请选择有效的 Azure 区域并提供公网 IP 创建请求标识'), { statusCode: 400 })
    }
    await this._ensureInitialized()
    assertAzureFreeSubscription(this.subscription)
    return withAzureAllocationLock(this.subscriptionId, async () => {
      const name = `cm-pip-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`
      await withAzureNetworkRetry('检查订阅区域策略', () => this._assertLocationAllowed(location))
      await withAzureNetworkRetry('检查资源提供程序注册', () => this._ensureResourceProvidersRegistered())
      const existing = await withAzureNetworkRetry('检查公网 IP 配额和已有地址', () => this._assertPublicIpCapacity(location, name))
      if (existing) {
        if (existing.tags?.publicIpRequestId !== requestId) {
          throw Object.assign(new Error('同名公网 IP 不属于此次创建请求'), { statusCode: 409 })
        }
        return AzureProvider.normalizePublicIp(existing)
      }
      await withAzureNetworkRetry('准备公网 IP 资源组', () => this._ensureResourceGroup(this._defaultResourceGroupName(), location))
      const ip = await withAzureNetworkRetry('创建收费静态公网 IPv4', () => this.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(
        this._defaultResourceGroupName(), name, {
          location, tags: { managedBy: 'cloud-manager', publicIpRequestId: requestId },
          sku: { name: 'Standard', tier: 'Regional' }, publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4'
        }))
      return AzureProvider.normalizePublicIp(ip)
    })
  }

  _defaultResourceGroupName() {
    return safeName(`cloud-manager-${this.accountName}`, 'cloud-manager-azure')
  }

  _resourceNames(location) {
    const suffix = safeName(location || 'default', 'default')
    return {
      resourceGroupName: this._defaultResourceGroupName(),
      virtualNetworkName: `cm-vnet-${suffix}`,
      subnetName: 'default',
      networkSecurityGroupName: `cm-nsg-${suffix}`
    }
  }

  async _ensureResourceGroup(resourceGroupName, location) {
    await this._ensureInitialized()
    const groups = this.resourceClient.resourceGroups
    // The group's location stores its metadata; resources inside it may use
    // other regions. Never change an existing group's location or tags.
    try {
      return await groups.get(resourceGroupName)
    } catch (error) {
      if (error.statusCode !== 404) throw error
    }
    try {
      return await groups.createOrUpdate(resourceGroupName, {
        location,
        tags: { managedBy: 'cloud-manager' }
      })
    } catch (error) {
      if (!isAzureResourceGroupLocationError(error)) throw error
      // Another task may have created the group in a different region since
      // our 404. Re-read that group instead of repeatedly trying to move it.
      try {
        return await groups.get(resourceGroupName)
      } catch (readError) {
        if (readError.statusCode === 404) throw error
        throw readError
      }
    }
  }

  async _ensureNetworkSecurityGroup(resourceGroupName, location, networkSecurityGroupName) {
    await this._ensureInitialized()

    try {
      return await this.networkClient.networkSecurityGroups.get(resourceGroupName, networkSecurityGroupName)
    } catch (error) {
      if (error.statusCode !== 404) throw error
    }

    return this.networkClient.networkSecurityGroups.beginCreateOrUpdateAndWait(resourceGroupName, networkSecurityGroupName, {
      location,
      tags: { managedBy: 'cloud-manager' },
      securityRules: [
        {
          name: 'allow-ssh',
          access: 'Allow',
          direction: 'Inbound',
          priority: 1000,
          protocol: 'Tcp',
          sourcePortRange: '*',
          destinationPortRange: '22',
          sourceAddressPrefix: '*',
          destinationAddressPrefix: '*'
        }
      ]
    })
  }

  async _ensureVirtualNetwork(resourceGroupName, location, virtualNetworkName) {
    await this._ensureInitialized()

    try {
      return await this.networkClient.virtualNetworks.get(resourceGroupName, virtualNetworkName)
    } catch (error) {
      if (error.statusCode !== 404) throw error
    }

    return this.networkClient.virtualNetworks.beginCreateOrUpdateAndWait(resourceGroupName, virtualNetworkName, {
      location,
      tags: { managedBy: 'cloud-manager' },
      addressSpace: {
        addressPrefixes: ['10.30.0.0/16']
      }
    })
  }

  async _ensureSubnet(resourceGroupName, virtualNetworkName, subnetName, networkSecurityGroupId) {
    await this._ensureInitialized()

    try {
      const subnet = await this.networkClient.subnets.get(resourceGroupName, virtualNetworkName, subnetName)
      if (networkSecurityGroupId && subnet.networkSecurityGroup?.id !== networkSecurityGroupId) {
        return this.networkClient.subnets.beginCreateOrUpdateAndWait(resourceGroupName, virtualNetworkName, subnetName, {
          addressPrefix: subnet.addressPrefix || '10.30.1.0/24',
          networkSecurityGroup: { id: networkSecurityGroupId }
        })
      }
      return subnet
    } catch (error) {
      if (error.statusCode !== 404) throw error
    }

    return this.networkClient.subnets.beginCreateOrUpdateAndWait(resourceGroupName, virtualNetworkName, subnetName, {
      addressPrefix: '10.30.1.0/24',
      defaultOutboundAccess: false,
      networkSecurityGroup: networkSecurityGroupId ? { id: networkSecurityGroupId } : undefined
    })
  }

  async _ensureDefaultNetwork(location) {
    const names = this._resourceNames(location)

    await withAzureNetworkRetry('准备资源组', () => this._ensureResourceGroup(names.resourceGroupName, location))
    const nsg = await withAzureNetworkRetry('准备安全组', () => this._ensureNetworkSecurityGroup(names.resourceGroupName, location, names.networkSecurityGroupName))
    await withAzureNetworkRetry('准备虚拟网络', () => this._ensureVirtualNetwork(names.resourceGroupName, location, names.virtualNetworkName))
    const subnet = await withAzureNetworkRetry('准备子网', () => this._ensureSubnet(names.resourceGroupName, names.virtualNetworkName, names.subnetName, nsg.id))

    return {
      ...names,
      subnet,
      networkSecurityGroup: nsg
    }
  }

  async _getNicById(id) {
    const { resourceGroup, resourceName } = parseAzureResourceId(id)
    if (!resourceGroup || !resourceName) {
      throw new Error(`无法解析 Azure 网卡资源 ID: ${id}`)
    }
    return this.networkClient.networkInterfaces.get(resourceGroup, resourceName)
  }

  async _getPublicIpById(id) {
    const { resourceGroup, resourceName } = parseAzureResourceId(id)
    if (!resourceGroup || !resourceName) {
      throw new Error(`无法解析 Azure 公网 IP 资源 ID: ${id}`)
    }
    return this.networkClient.publicIPAddresses.get(resourceGroup, resourceName)
  }

  async _collectVmNetworkDetails(vm) {
    const publicIps = []
    const privateIps = []
    const ipv6Addresses = []

    for (const nicRef of vm.networkProfile?.networkInterfaces || []) {
      if (!nicRef.id) continue
      const nic = await this._getNicById(nicRef.id)

      for (const config of nic.ipConfigurations || []) {
        if (config.privateIPAddress) {
          if (String(config.privateIPAddressVersion || 'IPv4').toUpperCase() === 'IPV6') ipv6Addresses.push(config.privateIPAddress)
          else privateIps.push(config.privateIPAddress)
        }

        if (config.publicIPAddress?.id) {
          try {
            const publicIp = await this._getPublicIpById(config.publicIPAddress.id)
            if (publicIp.ipAddress) {
              if (String(publicIp.publicIPAddressVersion || 'IPv4').toUpperCase() === 'IPV6') ipv6Addresses.push(publicIp.ipAddress)
              else publicIps.push(publicIp.ipAddress)
            }
          } catch (_) {
          }
        }
      }
    }

    return { publicIps, privateIps, ipv6Addresses }
  }

  _sumAzureMetricTotals(metric = {}) {
    return (metric.timeseries || [])
      .flatMap((series) => series.data || [])
      .reduce((sum, point) => sum + Number(point.total || 0), 0)
  }

  async _getVmNetworkUsage(vmId, options = {}) {
    const token = await this._getArmToken()
    const endTime = options.endTime ? new Date(options.endTime) : new Date()
    const startTime = options.startTime ? new Date(options.startTime) : new Date(endTime.getTime() - 24 * 60 * 60 * 1000)
    const params = new URLSearchParams({
      'api-version': AZURE_MONITOR_METRICS_API_VERSION,
      timespan: `${startTime.toISOString()}/${endTime.toISOString()}`,
      interval: options.interval || 'PT1H',
      aggregation: 'Total',
      metricnames: 'Network In Total,Network Out Total'
    })

    const response = await axios.get(`https://management.azure.com${vmId}/providers/Microsoft.Insights/metrics?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })

    const values = Array.isArray(response.data?.value) ? response.data.value : []
    const inMetric = values.find((item) => String(item.name?.value || item.name?.localizedValue || '').toLowerCase() === 'network in total')
    const outMetric = values.find((item) => String(item.name?.value || item.name?.localizedValue || '').toLowerCase() === 'network out total')

    return {
      networkInBytes24h: inMetric ? this._sumAzureMetricTotals(inMetric) : null,
      networkOutBytes24h: outMetric ? this._sumAzureMetricTotals(outMetric) : null
    }
  }

  async getNetworkUsage(instanceIds = [], options = {}) {
    await this._ensureInitialized()
    const usageMap = new Map()

    await Promise.all(instanceIds.map(async (instanceId) => {
      try {
        const usage = await this._getVmNetworkUsage(instanceId, {
          startTime: options.startTime,
          endTime: options.endTime,
          interval: options.interval || 'PT1H'
        })
        usageMap.set(instanceId, {
          inBytes: usage.networkInBytes24h,
          outBytes: usage.networkOutBytes24h
        })
      } catch (_) {
        usageMap.set(instanceId, { inBytes: null, outBytes: null })
      }
    }))

    return usageMap
  }

  async listInstances() {
    await this._ensureInitialized()
    const vms = []

    for await (const vm of this.computeClient.virtualMachines.listAll()) {
      vms.push(vm)
    }

    return Promise.all(vms.map(async (vm) => {
      const parsed = parseAzureResourceId(vm.id)
      let instanceView = null
      let networkDetails = { publicIps: [], privateIps: [], ipv6Addresses: [] }

      try {
        instanceView = await this.computeClient.virtualMachines.instanceView(parsed.resourceGroup, vm.name)
      } catch (_) {
      }

      try {
        networkDetails = await this._collectVmNetworkDetails(vm)
      } catch (_) {
      }

      let networkUsage = { networkInBytes24h: null, networkOutBytes24h: null }
      if (networkDetails.publicIps.length > 0) {
        try {
          networkUsage = await this._getVmNetworkUsage(vm.id)
        } catch (_) {
        }
      }

      return AzureProvider.normalizeInstance(vm, {
        state: mapPowerState(instanceView?.statuses),
        publicIps: networkDetails.publicIps,
        privateIps: networkDetails.privateIps,
        ipv6Addresses: networkDetails.ipv6Addresses,
        ...networkUsage
      })
    }))
  }

  async getInstance(instanceId) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    if (!parsed.resourceGroup || !parsed.resourceName) {
      throw new Error(`无法识别 Azure 实例 ID: ${instanceId}`)
    }

    const vm = await this.computeClient.virtualMachines.get(parsed.resourceGroup, parsed.resourceName)
    const instanceView = await this.computeClient.virtualMachines.instanceView(parsed.resourceGroup, parsed.resourceName)
    const networkDetails = await this._collectVmNetworkDetails(vm)
    let networkUsage = { networkInBytes24h: null, networkOutBytes24h: null }
    if (networkDetails.publicIps.length > 0) {
      try {
        networkUsage = await this._getVmNetworkUsage(vm.id)
      } catch (_) {
      }
    }

    return AzureProvider.normalizeInstance(vm, {
      state: mapPowerState(instanceView?.statuses),
      publicIps: networkDetails.publicIps,
      privateIps: networkDetails.privateIps,
      ipv6Addresses: networkDetails.ipv6Addresses,
      ...networkUsage
    })
  }

  async createInstance(params = {}, context = {}) {
    // Validate both direct requests and restored queue jobs before any write.
    validateAzureFreeCreateParams(params)
    if (!params.adminPassword) throw Object.assign(new Error('Azure 实例创建需要 adminPassword'), { retryable: false })
    if (!params.location || !params.vmSize) params = await this.prepareFreeCreate(params)
    const config = validateAzureFreeCreateParams(params)
    if (typeof params.subscriptionId !== 'string' || !params.subscriptionId.trim()) {
      throw Object.assign(new Error('请选择 Azure 订阅'), { statusCode: 400, retryable: false })
    }
    this.useSubscription(params.subscriptionId)
    await withAzureNetworkRetry('初始化订阅和身份认证', () => this._ensureInitialized())
    assertAzureFreeSubscription(this.subscription)
    return withAzureAllocationLock(this.subscriptionId, async () => {
      const location = String(params.location).trim().toLowerCase()
      const creationId = context.creationId || randomUUID()
      const vmName = `cm-${createHash('sha256').update(creationId).digest('hex').slice(0, 32)}`
      const resourceGroup = this._defaultResourceGroupName()
      const vmId = `/subscriptions/${this.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/virtualMachines/${vmName}`
      let existing
      try { existing = await this.computeClient.virtualMachines.get(resourceGroup, vmName) }
      catch (error) { if (error.statusCode !== 404) throw error }
      if (existing) {
        if (existing.tags?.managedBy !== 'cloud-manager' || existing.hardwareProfile?.vmSize !== config.vmSize ||
            existing.storageProfile?.osDisk?.managedDisk?.storageAccountType !== 'Premium_LRS' ||
            existing.storageProfile?.osDisk?.diskSizeGB !== 64) {
          throw azureFreeOnlyError('此任务已有不符合当前免费配置的实例，请先检查并清理原资源')
        }
        if (existing.provisioningState === 'Succeeded') return { instanceId: existing.id, displayName: existing.name }
      }
      const state = await this._getFreeCreateState()
      const reason = azureFreeAllocationReason({ ...state, location, vmSize: config.vmSize,
        vmId, diskId: existing?.storageProfile?.osDisk?.managedDisk?.id })
      if (reason) throw azureFreeOnlyError(reason)
      await withAzureNetworkRetry('检查订阅区域策略', () => this._assertLocationAllowed(location))
      await withAzureNetworkRetry('检查实例规格可用性', () => this._assertVmSizeAvailable(location, config.vmSize))
      await withAzureNetworkRetry('检查资源提供程序注册', () => this._ensureResourceProvidersRegistered())
      const network = await this._ensureDefaultNetwork(location)
      const publicIp = config.createPublicIp ? await this._ensureVmPublicIp(location, vmName, vmId) : null
      if (publicIp && AzureProvider.normalizePublicIp(publicIp).associated) {
        const expected = `/subscriptions/${this.subscriptionId}/resourceGroups/${network.resourceGroupName}/providers/Microsoft.Network/networkInterfaces/${vmName}-nic/ipConfigurations/ipconfig1`
        if (publicIp.ipConfiguration?.id?.toLowerCase() !== expected.toLowerCase() || publicIp.natGateway ||
            publicIp.servicePublicIPAddress || publicIp.linkedPublicIPAddress) {
          throw Object.assign(new Error('任务公网 IP 已关联到其他资源，不能复用'), { statusCode: 409, retryable: false })
        }
      }
      const nic = await withAzureNetworkRetry('创建网卡', () => this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(
        network.resourceGroupName, `${vmName}-nic`, {
          location, tags: { managedBy: 'cloud-manager', vmName },
          networkSecurityGroup: { id: network.networkSecurityGroup.id },
          ipConfigurations: [{ name: 'ipconfig1', subnet: { id: network.subnet.id }, privateIPAllocationMethod: 'Dynamic', primary: true,
            ...(publicIp ? { publicIPAddress: { id: publicIp.id, deleteOption: 'Delete' } } : {}) }]
        }))
      const vm = await withAzureNetworkRetry('创建虚拟机', () => this.computeClient.virtualMachines.beginCreateOrUpdateAndWait(
        network.resourceGroupName, vmName, {
          location, tags: { managedBy: 'cloud-manager' }, hardwareProfile: { vmSize: config.vmSize },
          osProfile: { computerName: vmName, adminUsername: params.adminUsername || 'azureuser', adminPassword: params.adminPassword,
            linuxConfiguration: { disablePasswordAuthentication: false } },
          storageProfile: { imageReference: config.image,
            osDisk: { name: `${vmName}-os`, createOption: 'FromImage', deleteOption: 'Delete', diskSizeGB: 64,
              managedDisk: { storageAccountType: 'Premium_LRS' } } },
          diagnosticsProfile: { bootDiagnostics: { enabled: false } },
          networkProfile: { networkInterfaces: [{ id: nic.id, primary: true, deleteOption: 'Delete' }] }
        }))
      return { instanceId: vm.id, displayName: vm.name || vmName }
    })
  }

  static normalizePublicIp(raw) {
    const associations = [raw.ipConfiguration, raw.natGateway, raw.servicePublicIPAddress, raw.linkedPublicIPAddress].filter(Boolean)
    const associated = associations.length > 0
    const state = raw.provisioningState || 'Unknown'
    return {
      id: raw.id,
      name: raw.name,
      ipAddress: raw.ipAddress || '',
      version: raw.publicIPAddressVersion || '',
      sku: raw.sku?.name || '',
      allocationMethod: raw.publicIPAllocationMethod || '',
      tier: raw.sku?.tier || '',
      region: raw.location,
      resourceGroup: parseAzureResourceId(raw.id).resourceGroup,
      state,
      associated,
      associationIds: associations.map((item) => item.id).filter(Boolean),
      canBind: !associated && state === 'Succeeded' && raw.sku?.name === 'Standard' &&
        (!raw.sku?.tier || raw.sku.tier === 'Regional') && raw.publicIPAddressVersion === 'IPv4' &&
        raw.publicIPAllocationMethod === 'Static' && (!raw.migrationPhase || raw.migrationPhase === 'None'),
      canDelete: !associated && ['Succeeded', 'Failed'].includes(state) && (!raw.migrationPhase || raw.migrationPhase === 'None')
    }
  }

  async listPublicIps() {
    await this._ensureInitialized()
    return withAzureNetworkRetry('查询公网 IP', async () => {
      const items = []
      for await (const ip of this.networkClient.publicIPAddresses.listAll()) {
        const item = AzureProvider.normalizePublicIp(ip)
        item.canDetach = false
        if (ip.ipConfiguration && !ip.natGateway && !ip.servicePublicIPAddress && !ip.linkedPublicIPAddress) {
          try {
            const { nic } = await this._getUnusedPublicIpNic(ip)
            item.canDetach = true
            item.nicName = nic.name
          } catch (error) {
            item.detachReason = error.statusCode === 409 ? error.message : '无法确认关联网卡是否空闲，请刷新重试'
          }
        }
        items.push(item)
      }
      return items
    })
  }

  async _getUnusedPublicIpNic(ip) {
    const reject = (message) => { throw Object.assign(new Error(message), { statusCode: 409 }) }
    if (ip.natGateway || ip.servicePublicIPAddress || ip.linkedPublicIPAddress ||
        !['Succeeded', 'Failed'].includes(ip.provisioningState) || (ip.migrationPhase && ip.migrationPhase !== 'None')) {
      reject('该公网 IP 不支持解除关联，请检查关联资源和状态')
    }
    const parts = String(ip.ipConfiguration?.id || '').split('/').filter(Boolean)
    if (parts.length !== 10 || parts[0].toLowerCase() !== 'subscriptions' ||
        parts[1].toLowerCase() !== this.subscriptionId.toLowerCase() || parts[2].toLowerCase() !== 'resourcegroups' ||
        parts[4].toLowerCase() !== 'providers' || parts[5].toLowerCase() !== 'microsoft.network' ||
        parts[6].toLowerCase() !== 'networkinterfaces' || parts[8].toLowerCase() !== 'ipconfigurations') {
      reject('仅支持解绑当前订阅中未绑定实例的独立网卡')
    }
    const nicId = '/' + parts.slice(0, 8).join('/')
    const nic = await withAzureNetworkRetry('检查关联网卡', () => this.networkClient.networkInterfaces.get(parts[3], parts[7]))
    if (nic.id?.toLowerCase() !== nicId.toLowerCase()) reject('关联网卡 ID 不匹配，请刷新重试')
    if (nic.virtualMachine || nic.privateEndpoint || nic.privateLinkService || nic.hostedWorkloads?.length) {
      reject('关联网卡已绑定实例或其他服务，不能解绑')
    }
    if (!['Succeeded', 'Failed'].includes(nic.provisioningState) || (nic.migrationPhase && nic.migrationPhase !== 'None')) {
      reject('关联网卡正在变更或状态未知，请稍后刷新重试')
    }
    const config = nic.ipConfigurations?.find((item) => item.id?.toLowerCase() === ip.ipConfiguration.id.toLowerCase())
    if (!config || config.publicIPAddress?.id?.toLowerCase() !== ip.id?.toLowerCase() || !nic.etag) {
      reject('无法确认公网 IP 与网卡的关联状态，请刷新重试')
    }
    return { nic, config, resourceGroup: parts[3], name: parts[7] }
  }

  async deletePublicIp(publicIpId, { detachUnusedNic = false, expectedNicId = '' } = {}) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(publicIpId)
    if (parsed.parts.length !== 8 || !parsed.resourceGroup || !parsed.resourceName ||
        parsed.subscriptionId.toLowerCase() !== this.subscriptionId.toLowerCase() ||
        parsed.provider.toLowerCase() !== 'microsoft.network' || parsed.resourceType.toLowerCase() !== 'publicipaddresses') {
      throw Object.assign(new Error('公网 IP ID 无效或不属于当前订阅'), { statusCode: 400 })
    }
    // Check live state immediately before deletion. Azure also rejects deletion
    // if another resource associates the address after this read.
    let raw = await withAzureNetworkRetry('检查公网 IP 使用状态', () =>
      this.networkClient.publicIPAddresses.get(parsed.resourceGroup, parsed.resourceName))
    let detachedNicId = ''
    if (detachUnusedNic && AzureProvider.normalizePublicIp(raw).associated) {
      const { nic, config, resourceGroup, name } = await this._getUnusedPublicIpNic(raw)
      if (expectedNicId && nic.id.toLowerCase() !== expectedNicId.toLowerCase()) {
        throw Object.assign(new Error('公网 IP 已被其他资源使用，未删除'), { statusCode: 409 })
      }
      // Preserve all other NIC settings and IP configurations. Conditional update
      // rejects changes since the live check, including a concurrent VM attach.
      await this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(resourceGroup, name, {
        ...nic,
        ipConfigurations: nic.ipConfigurations.map((item) => item === config ? { ...item, publicIPAddress: null } : item)
      }, { requestOptions: { customHeaders: { 'If-Match': nic.etag } } })
      detachedNicId = nic.id
      raw = await this.networkClient.publicIPAddresses.get(parsed.resourceGroup, parsed.resourceName)
    }
    const ip = AzureProvider.normalizePublicIp(raw)
    if (!ip.canDelete) {
      throw Object.assign(new Error(ip.associated ? '该公网 IP 正在使用，不能删除' : '公网 IP 状态不允许删除，请稍后刷新重试'), { statusCode: 409 })
    }
    try {
      await this.networkClient.publicIPAddresses.beginDeleteAndWait(parsed.resourceGroup, parsed.resourceName)
    } catch (error) {
      if (detachedNicId) {
        throw Object.assign(new Error(`已解除网卡关联，但删除公网 IP 失败，请刷新后重试删除：${error.message}`, { cause: error }), { statusCode: error.statusCode })
      }
      throw error
    }
    return { publicIpId, name: ip.name, ipAddress: ip.ipAddress, ...(detachedNicId ? { detachedNicId } : {}) }
  }

  async bindPublicIp(instanceId, { mode, publicIpId } = {}) {
    if (!['new', 'existing'].includes(mode) || (mode === 'existing' && (typeof publicIpId !== 'string' || !publicIpId))) {
      throw Object.assign(new Error('请选择新建公网 IP 或指定已有公网 IP'), { statusCode: 400 })
    }
    await this._ensureInitialized()
    const parsed = this._validateResourceId(instanceId, 'Microsoft.Compute', 'virtualMachines')
    if (mode === 'existing') this._validateResourceId(publicIpId, 'Microsoft.Network', 'publicIPAddresses')
    assertAzureFreeSubscription(this.subscription)
    return withAzureAllocationLock(this.subscriptionId, async () => {
      const vm = await this.computeClient.virtualMachines.get(parsed.resourceGroup, parsed.resourceName)
      const refs = vm.networkProfile?.networkInterfaces || []
      const ref = refs.find(item => item.primary) || refs[0]
      if (!ref) throw Object.assign(new Error('实例没有可绑定公网 IP 的网卡'), { statusCode: 409 })
      const nicParsed = this._validateResourceId(ref.id, 'Microsoft.Network', 'networkInterfaces')
      const nic = await this.networkClient.networkInterfaces.get(nicParsed.resourceGroup, nicParsed.resourceName)
      if (nic.id?.toLowerCase() !== ref.id.toLowerCase() || nic.virtualMachine?.id?.toLowerCase() !== instanceId.toLowerCase() ||
          !nic.etag || nic.provisioningState !== 'Succeeded') {
        throw Object.assign(new Error('无法确认实例网卡状态，请刷新后重试'), { statusCode: 409 })
      }
      const ipv4Configs = (nic.ipConfigurations || []).filter(item => !item.privateIPAddressVersion || item.privateIPAddressVersion === 'IPv4')
      const config = ipv4Configs.find(item => item.primary) || ipv4Configs[0]
      if (!config) throw Object.assign(new Error('实例网卡没有 IPv4 配置'), { statusCode: 409 })
      const desiredId = mode === 'existing' ? publicIpId :
        `/subscriptions/${this.subscriptionId}/resourceGroups/${this._defaultResourceGroupName()}/providers/Microsoft.Network/publicIPAddresses/${this._publicIpName(instanceId)}`
      if (config.publicIPAddress?.id) {
        if (config.publicIPAddress.id.toLowerCase() !== desiredId.toLowerCase()) {
          throw Object.assign(new Error('实例已绑定公网 IP，不会替换已有地址'), { statusCode: 409 })
        }
        const ip = await this._getPublicIpById(desiredId)
        return { instanceId, publicIpId: ip.id, ipAddress: ip.ipAddress || '' }
      }
      let ip
      if (mode === 'new') {
        await withAzureNetworkRetry('准备公网 IP 资源组', () => this._ensureResourceGroup(this._defaultResourceGroupName(), vm.location))
        await withAzureNetworkRetry('检查资源提供程序注册', () => this._ensureResourceProvidersRegistered())
        ip = await this._ensureVmPublicIp(vm.location, vm.name, instanceId, vm.zones)
      } else {
        ip = await this._getPublicIpById(publicIpId)
      }
      this._validateResourceId(ip.id, 'Microsoft.Network', 'publicIPAddresses')
      const normalized = AzureProvider.normalizePublicIp(ip)
      if (!normalized.canBind) {
        throw Object.assign(new Error('仅支持未关联、状态正常的 Standard 区域静态公网 IPv4，请刷新列表'), { statusCode: 409 })
      }
      if (ip.location?.toLowerCase() !== vm.location?.toLowerCase() ||
          (vm.zones?.length && ip.zones?.length && !vm.zones.every(zone => ip.zones.includes(zone)))) {
        throw Object.assign(new Error('公网 IP 必须与实例位于相同区域，且可用区兼容'), { statusCode: 400 })
      }
      try {
        await this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(nicParsed.resourceGroup, nicParsed.resourceName, {
          ...nic,
          ipConfigurations: nic.ipConfigurations.map(item => item === config
            ? { ...item, publicIPAddress: { id: ip.id, deleteOption: 'Delete' } } : item)
        }, { requestOptions: { customHeaders: { 'If-Match': nic.etag } } })
      } catch (error) {
        // A lost response may hide a successful bind. Reconcile before reporting
        // failure, and retain the stable address for an explicit retry.
        let latest
        try { latest = await this._getNicById(nic.id) } catch (_) {}
        if (!latest?.ipConfigurations?.some(item => item.name === config.name && item.publicIPAddress?.id?.toLowerCase() === ip.id.toLowerCase())) {
          throw Object.assign(new Error(`绑定公网 IP 失败：${error.message}。地址「${ip.name}」已保留，可重试绑定或在“管理公网 IP”中检查并删除，保留期间可能计费。`, { cause: error }),
            { statusCode: error.statusCode, publicIpId: ip.id })
        }
      }
      return { instanceId, publicIpId: ip.id, ipAddress: ip.ipAddress || '' }
    })
  }

  async renameInstance(instanceId, displayName) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    if (!parsed.resourceGroup || !parsed.resourceName ||
        parsed.subscriptionId.toLowerCase() !== this.subscriptionId.toLowerCase() ||
        parsed.provider.toLowerCase() !== 'microsoft.compute' ||
        parsed.resourceType.toLowerCase() !== 'virtualmachines' || parsed.parts.length !== 8) {
      throw new Error(`无法识别当前订阅的 Azure 实例 ID: ${instanceId}`)
    }
    await this.resourceClient.tagsOperations.beginUpdateAtScopeAndWait(instanceId, {
      operation: 'Merge',
      properties: { tags: { [DISPLAY_NAME_TAG]: displayName } }
    })
    return { instanceId, displayName }
  }

  _validateResourceId(id, provider, type) {
    const parsed = parseAzureResourceId(id)
    if (parsed.parts.length !== 8 || !parsed.resourceGroup || !parsed.resourceName ||
        parsed.subscriptionId.toLowerCase() !== this.subscriptionId?.toLowerCase() ||
        parsed.provider.toLowerCase() !== provider.toLowerCase() || parsed.resourceType.toLowerCase() !== type.toLowerCase()) {
      throw Object.assign(new Error(`无法识别当前订阅的 Azure ${type} ID: ${id}`), { statusCode: 400 })
    }
    return parsed
  }

  async deleteInstance(instanceId) {
    await this._ensureInitialized()
    return withAzureAllocationLock(this.subscriptionId, () => this._deleteInstance(instanceId))
  }

  async _deleteInstance(instanceId) {
    const parsed = this._validateResourceId(instanceId, 'Microsoft.Compute', 'virtualMachines')
    const vm = await this.computeClient.virtualMachines.get(parsed.resourceGroup, parsed.resourceName)
    const owned = vm.tags?.managedBy === 'cloud-manager'
    const candidates = new Map()
    const retained = []
    const add = (kind, id, extra = {}) => { if (id) candidates.set(id.toLowerCase(), { kind, id, ...extra }) }
    const osDisk = vm.storageProfile?.osDisk
    const disks = [osDisk, ...(vm.storageProfile?.dataDisks || [])].filter(Boolean)
    for (const disk of disks) {
      if (!disk.managedDisk?.id) continue
      this._validateResourceId(disk.managedDisk.id, 'Microsoft.Compute', 'disks')
      if (disk.deleteOption === 'Delete' || (owned && disk === osDisk && disk.createOption === 'FromImage')) {
        add('disk', disk.managedDisk.id)
      } else retained.push({ id: disk.managedDisk.id, reason: '保留未声明随实例删除的磁盘，仍可能产生存储费用' })
    }
    // Collect dependencies before VM deletion cascades to the NIC and OS disk.
    for (const ref of vm.networkProfile?.networkInterfaces || []) {
      const nicParsed = this._validateResourceId(ref.id, 'Microsoft.Network', 'networkInterfaces')
      const nic = await this.networkClient.networkInterfaces.get(nicParsed.resourceGroup, nicParsed.resourceName)
      if (nic.virtualMachine?.id && nic.virtualMachine.id.toLowerCase() !== instanceId.toLowerCase()) {
        throw Object.assign(new Error('网卡已被其他实例使用，无法安全清理关联资源'), { statusCode: 409 })
      }
      if (ref.deleteOption !== 'Delete' && !(owned && nic.tags?.managedBy === 'cloud-manager' && nic.tags?.vmName === vm.name)) {
        retained.push({ id: ref.id, reason: '保留非本实例专属网卡；绑定的公网 IP 会解除关联并删除' })
      } else add('nic', ref.id)
      for (const config of nic.ipConfigurations || []) {
        const id = config.publicIPAddress?.id
        if (!id) continue
        this._validateResourceId(id, 'Microsoft.Network', 'publicIPAddresses')
        await this._getPublicIpById(id)
        add('ip', id, { nicId: ref.id })
      }
    }

    await this.computeClient.virtualMachines.beginDeleteAndWait(parsed.resourceGroup, parsed.resourceName)
    const deleted = []
    const failed = []
    // Deleting an exclusive NIC first releases its public IP association.
    for (const resource of [...candidates.values()].sort((a, b) => ['nic', 'ip', 'disk'].indexOf(a.kind) - ['nic', 'ip', 'disk'].indexOf(b.kind))) {
      const { resourceGroup, resourceName } = parseAzureResourceId(resource.id)
      const client = resource.kind === 'disk' ? this.computeClient.disks
        : resource.kind === 'nic' ? this.networkClient.networkInterfaces : this.networkClient.publicIPAddresses
      try {
        const current = await client.get(resourceGroup, resourceName)
        if (resource.kind === 'disk' && (current.managedBy || current.managedByExtended?.length || current.diskState !== 'Unattached')) {
          throw new Error('磁盘尚未释放或已被其他资源使用，未删除')
        }
        if (resource.kind === 'nic' && (current.virtualMachine?.id || current.privateEndpoint?.id || current.privateLinkService || current.hostedWorkloads?.length)) throw new Error('网卡仍被使用，未删除')
        if (resource.kind === 'ip') {
          await this.deletePublicIp(resource.id, { detachUnusedNic: true, expectedNicId: resource.nicId })
          deleted.push(resource.id)
          continue
        }
        await client.beginDeleteAndWait(resourceGroup, resourceName)
        deleted.push(resource.id)
      } catch (error) {
        if (error.statusCode === 404) deleted.push(resource.id)
        else failed.push({ id: resource.id, error: error.message })
      }
    }
    return { instanceId, cleanup: { complete: failed.length === 0 && retained.length === 0, deleted, retained, failed } }
  }

  async instanceAction(instanceId, action) {
    await this._ensureInitialized()
    const parsed = this._validateResourceId(instanceId, 'Microsoft.Compute', 'virtualMachines')

    if (['START', 'REBOOT', 'HARD_REBOOT'].includes(action)) {
      assertAzureFreeSubscription(this.subscription)
      const vm = await this.computeClient.virtualMachines.get(parsed.resourceGroup, parsed.resourceName)
      getAzureFreeVmProfile(vm.hardwareProfile?.vmSize || '')
      const charges = await this._getFreeVmCharges(this.subscriptionId, true)
      if (this._applyVmCharges([{ name: vm.hardwareProfile.vmSize, available: true }], vm.location || '', charges)[0].available === false) {
        throw azureFreeOnlyError('本月此实例的区域和规格已有实际计算费用，免费模式不允许启动或重启')
      }
      const method = action === 'START' ? 'beginStartAndWait' : 'beginRestartAndWait'
      await this.computeClient.virtualMachines[method](parsed.resourceGroup, parsed.resourceName)
      return { instanceId, action }
    }

    switch (action) {
      case 'STOP':
        await this.computeClient.virtualMachines.beginDeallocateAndWait(parsed.resourceGroup, parsed.resourceName)
        break
      default:
        throw new Error(`Azure 不支持的实例操作: ${action}`)
    }

    return { instanceId, action }
  }

  async _updateNic(nic) {
    const parsed = parseAzureResourceId(nic.id)
    return this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(parsed.resourceGroup, parsed.resourceName, {
      location: nic.location,
      tags: nic.tags,
      enableAcceleratedNetworking: nic.enableAcceleratedNetworking,
      enableIPForwarding: nic.enableIPForwarding,
      networkSecurityGroup: nic.networkSecurityGroup,
      dnsSettings: nic.dnsSettings,
      ipConfigurations: (nic.ipConfigurations || []).map((config) => ({
        name: config.name,
        privateIPAddress: config.privateIPAddress,
        privateIPAllocationMethod: config.privateIPAllocationMethod,
        privateIPAddressVersion: config.privateIPAddressVersion,
        subnet: config.subnet,
        publicIPAddress: config.publicIPAddress,
        primary: config.primary
      }))
    })
  }

  async switchPublicIp() {
    throw azureFreeOnlyError('免费模式不创建或切换收费公网 IP')
  }

  async allowAllInboundTraffic(instanceId) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    const vm = await this.computeClient.virtualMachines.get(parsed.resourceGroup, parsed.resourceName)
    const primaryNicRef = vm.networkProfile?.networkInterfaces?.find((item) => item.primary) || vm.networkProfile?.networkInterfaces?.[0]

    if (!primaryNicRef?.id) {
      throw new Error('Azure 实例未绑定网卡，无法配置防火墙')
    }

    const nic = await this._getNicById(primaryNicRef.id)
    const nicParsed = parseAzureResourceId(nic.id)
    let nsgRef = nic.networkSecurityGroup

    if (!nsgRef?.id) {
      const nsg = await this._ensureNetworkSecurityGroup(
        nicParsed.resourceGroup,
        vm.location || 'eastasia',
        `${safeName(nic.name || vm.name || 'azure-vm')}-nsg`
      )
      nic.networkSecurityGroup = { id: nsg.id }
      await this._updateNic(nic)
      nsgRef = { id: nsg.id }
    }

    const nsgParsed = parseAzureResourceId(nsgRef.id)
    const nsg = await this.networkClient.networkSecurityGroups.get(nsgParsed.resourceGroup, nsgParsed.resourceName)
    const existingRules = Array.isArray(nsg.securityRules) ? nsg.securityRules : []
    const ruleName = 'cloud-manager-allow-all-inbound'
    const filteredRules = existingRules.filter((item) => item.name !== ruleName)

    filteredRules.push({
      name: ruleName,
      access: 'Allow',
      direction: 'Inbound',
      priority: 100,
      protocol: '*',
      sourcePortRange: '*',
      destinationPortRange: '*',
      sourceAddressPrefix: '*',
      destinationAddressPrefix: '*'
    })

    await this.networkClient.networkSecurityGroups.beginCreateOrUpdateAndWait(nsgParsed.resourceGroup, nsgParsed.resourceName, {
      location: nsg.location || vm.location,
      tags: nsg.tags,
      securityRules: filteredRules
    })

    return { success: true }
  }

  static normalizeInstance(raw, details = {}) {
    return {
      id: raw.id,
      displayName: raw.tags?.[DISPLAY_NAME_TAG] || raw.name,
      state: details.state || raw.provisioningState || 'UNKNOWN',
      publicIps: details.publicIps || [],
      privateIps: details.privateIps || [],
      ipv6Addresses: details.ipv6Addresses || [],
      region: raw.location,
      zone: raw.zones?.[0] || raw.location,
      shape: raw.hardwareProfile?.vmSize,
      cpu: Number(capabilityValue(raw, 'vCPUs')) || null,
      memoryGb: Number(capabilityValue(raw, 'MemoryGB')) || null,
      networkInBytes24h: Number.isFinite(Number(details.networkInBytes24h)) ? Number(details.networkInBytes24h) : null,
      networkOutBytes24h: Number.isFinite(Number(details.networkOutBytes24h)) ? Number(details.networkOutBytes24h) : null,
      provider: 'azure',
      timeCreated: raw.timeCreated || raw.properties?.timeCreated || null,
      raw
    }
  }
}
