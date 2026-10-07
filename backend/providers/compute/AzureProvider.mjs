import axios from 'axios'
import { createHash, randomUUID } from 'node:crypto'
import BaseComputeProvider from './BaseComputeProvider.mjs'
import { normalizeAzureCredentials } from '../../utils/azureCredentials.mjs'
import { isAzureResourceGroupLocationError, withAzureNetworkRetry } from '../../utils/azureRequest.mjs'
import { getAzureVmQuota } from '../../utils/azureVmQuota.mjs'
import { getAzurePublicIpQuota } from '../../utils/azurePublicIpQuota.mjs'

let azureSdkPromise = null
const azureBillingCache = new Map()
const AZURE_MONITOR_METRICS_API_VERSION = '2018-01-01'
const DISPLAY_NAME_TAG = 'cloud-manager-display-name'
const VM_RESOURCE_PROVIDERS = ['Microsoft.Network', 'Microsoft.Compute']
const PROVIDER_REGISTRATION_TIMEOUT_MS = 120000
const PROVIDER_REGISTRATION_POLL_MS = 5000
// https://azure.microsoft.com/en-us/free/ — free allowance SKUs, not billing entitlement.
// B2pts_v2 uses Arm and is incompatible with the default Ubuntu x64 image.
const AZURE_FREE_TIER_X64_VM_SIZES = new Set(['Standard_B1s', 'Standard_B2ats_v2'])

function safeName(input, fallback = 'cloud-manager') {
  const cleaned = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return (cleaned || fallback).slice(0, 50)
}

function randomSuffix(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length)
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
  static capabilities = ['switch_ip', 'switch_ipv6', 'allow_all_inbound_traffic', 'rename_instance', 'manage_public_ips']

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
  }

  async listVmSizes(location, subscriptionId) {
    if (!location) {
      throw new Error('Azure VM Size 查询需要 location')
    }

    const { ComputeManagementClient } = await this._loadSdk()
    await this._ensureCredential()

    const subscription = await this._resolveSubscription(subscriptionId)
    const client = new ComputeManagementClient(this.credential, subscription.subscriptionId)
    return this._listVmSizes(client, location)
  }

  async _listVmSizes(client, location, options = {}) {
    const [regionalSkus, usages] = await Promise.all([
      this._listRegionalVmSkus(client, location, options), this._listCpuUsage(client, location, options)
    ])
    const sizes = []

    // Resource SKUs is the subscription-specific source. Intersecting it with
    // the legacy VM sizes endpoint can drop current-generation VM sizes.
    for (const item of regionalSkus) {
      if (!item.name) continue
      const architecture = capabilityValue(item, 'CpuArchitectureType').toLowerCase()
      if ((architecture && architecture !== 'x64') || item.name === 'Standard_B2pts_v2') continue
      const generations = capabilityValue(item, 'HyperVGenerations')
      if (generations && !generations.split(',').some((value) => value.trim().toUpperCase() === 'V2')) continue
      const numberOfCores = Number(capabilityValue(item, 'vCPUs')) || null
      const memoryGb = Number(capabilityValue(item, 'MemoryGB')) || null
      const regionAvailable = AzureProvider.isVmSkuAvailable(item, location)
      const quota = getAzureVmQuota(item, usages)
      const available = regionAvailable && quota.sufficient === true
      sizes.push({
        name: item.name,
        numberOfCores,
        memoryInMB: memoryGb === null ? null : memoryGb * 1024,
        available,
        family: item.family,
        quota,
        freeTierCandidate: AZURE_FREE_TIER_X64_VM_SIZES.has(item.name),
        restrictionReason: !regionAvailable ? '当前订阅在此区域受限' : quota.reason,
        label: `${item.name} · ${numberOfCores ?? '?'} vCPU · ${memoryGb ?? '?'} GB`
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
    const locations = await this.listLocations(this.subscriptionId)
    const regions = []
    let cursor = 0
    // Reuse subscription-scoped clients with at most three regional scans in flight.
    await Promise.all(Array.from({ length: Math.min(3, locations.length) }, async () => {
      while (cursor < locations.length) {
        const location = locations[cursor++]
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30000)
        try {
          const requestOptions = { abortSignal: controller.signal }
          const [allSizes, usages] = await Promise.all([
            this._listVmSizes(this.computeClient, location.name, requestOptions),
            this._listNetworkUsage(this.networkClient, location.name, requestOptions)
          ])
          const sizes = allSizes.filter(size => size.freeTierCandidate)
          const publicIpQuota = getAzurePublicIpQuota(usages)
          const ready = publicIpQuota.sufficient === true && sizes.some(size => size.available)
          const unknown = publicIpQuota.sufficient === null || sizes.some(size => size.quota.sufficient === null)
          regions.push({ location: location.name, displayName: location.displayName,
            sizes, publicIpQuota, status: ready ? 'ready' : unknown ? 'unknown' : 'blocked',
            reason: publicIpQuota.reason || (sizes.length ? '' : '此区域没有兼容的 x64 免费候选规格') })
        } catch (error) {
          regions.push({ location: location.name, displayName: location.displayName, sizes: [], status: 'unknown',
            reason: controller.signal.aborted ? '区域查询超时，请刷新重试' : error.message })
        } finally {
          clearTimeout(timer)
          controller.abort()
        }
      }
    }))
    regions.sort((a, b) => a.location.localeCompare(b.location))
    const options = regions.flatMap(region => region.status === 'ready'
      ? region.sizes.filter(size => size.available).sort((a, b) => a.name.localeCompare(b.name)).map(size => ({
        location: region.location, displayName: region.displayName, vmSize: size.name,
        numberOfCores: size.numberOfCores, memoryInMB: size.memoryInMB,
        cpuQuota: size.quota, publicIpQuota: region.publicIpQuota
      })) : [])
    return { subscriptionId: this.subscriptionId, checkedAt: new Date().toISOString(), options, regions }
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
          existing.publicIPAddressVersion !== 'IPv4' || existing.tags?.managedBy !== 'cloud-manager' || existing.tags?.vmName !== vmName) {
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

  async createInstance(params, context = {}) {
    this.useSubscription(params.subscriptionId)
    await withAzureNetworkRetry('初始化订阅和身份认证', () => this._ensureInitialized())

    const location = params.location || 'eastasia'
    const vmSize = params.vmSize || 'Standard_B1s'
    const adminUsername = params.adminUsername || 'azureuser'
    const adminPassword = params.adminPassword

    if (!adminPassword) {
      throw new Error('Azure 实例创建需要 adminPassword')
    }

    const imagePublisher = params.imagePublisher || 'Canonical'
    const imageOffer = params.imageOffer || '0001-com-ubuntu-server-jammy'
    const imageSku = params.imageSku || '22_04-lts-gen2'
    const imageVersion = params.imageVersion || 'latest'

    const creationId = context.creationId || randomUUID()
    const vmName = `cm-${createHash('sha256').update(creationId).digest('hex').slice(0, 32)}`
    await withAzureNetworkRetry('检查资源提供程序注册', () => this._ensureResourceProvidersRegistered())
    if (context.creationId) {
      const existing = await withAzureNetworkRetry('检查已有实例', async () => {
        try {
          return await this.computeClient.virtualMachines.get(this._defaultResourceGroupName(), vmName)
        } catch (error) {
          if (error.statusCode === 404) return null
          throw error
        }
      })
      // A previous create response may have been lost after deployment succeeded.
      // Its CPU usage must not make the same task fail its fresh quota check.
      if (existing?.provisioningState === 'Succeeded') {
        return { instanceId: existing.id, displayName: existing.tags?.[DISPLAY_NAME_TAG] || existing.name || vmName }
      }
    }

    const publicIpName = `${vmName}-pip`
    const nicName = `${vmName}-nic`
    await withAzureNetworkRetry('检查订阅区域策略', () => this._assertLocationAllowed(location))
    // Check current quota before allocating network or VM resources.
    await withAzureNetworkRetry('检查实例规格可用性', () => this._assertVmSizeAvailable(location, vmSize))
    const existingPublicIp = await withAzureNetworkRetry('检查公网 IP 配额', () => this._assertPublicIpCapacity(location, publicIpName, vmName))
    const network = await this._ensureDefaultNetwork(location)
    // The task ID survives retries and restarts. Never generate another set of
    // resources merely because Azure accepted a PUT but its response was lost.
    const publicIp = existingPublicIp || await withAzureNetworkRetry('创建公网 IP', () => this.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(network.resourceGroupName, publicIpName, {
      location,
      publicIPAllocationMethod: 'Static',
      publicIPAddressVersion: 'IPv4',
      sku: { name: 'Standard' },
      tags: { managedBy: 'cloud-manager', vmName }
    }))

    const nic = await withAzureNetworkRetry('创建网卡', () => this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(network.resourceGroupName, nicName, {
      location,
      tags: { managedBy: 'cloud-manager', vmName },
      networkSecurityGroup: network.networkSecurityGroup?.id ? { id: network.networkSecurityGroup.id } : undefined,
      ipConfigurations: [
        {
          name: 'ipconfig1',
          subnet: { id: network.subnet.id },
          privateIPAllocationMethod: 'Dynamic',
          publicIPAddress: { id: publicIp.id },
          primary: true
        }
      ]
    }))

    const vm = await withAzureNetworkRetry('创建虚拟机', () => this.computeClient.virtualMachines.beginCreateOrUpdateAndWait(network.resourceGroupName, vmName, {
      location,
      tags: { managedBy: 'cloud-manager' },
      hardwareProfile: { vmSize },
      osProfile: {
        computerName: vmName,
        adminUsername,
        adminPassword,
        linuxConfiguration: {
          disablePasswordAuthentication: false
        }
      },
      storageProfile: {
        imageReference: {
          publisher: imagePublisher,
          offer: imageOffer,
          sku: imageSku,
          version: imageVersion
        },
        osDisk: {
          createOption: 'FromImage',
          deleteOption: 'Delete',
          managedDisk: {
            storageAccountType: 'Standard_LRS'
          }
        }
      },
      networkProfile: {
        networkInterfaces: [
          {
            id: nic.id,
            primary: true,
            deleteOption: 'Delete'
          }
        ]
      }
    }))

    return {
      instanceId: vm.id,
      displayName: vm.name || vmName
    }
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
      region: raw.location,
      resourceGroup: parseAzureResourceId(raw.id).resourceGroup,
      state,
      associated,
      associationIds: associations.map((item) => item.id).filter(Boolean),
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

  async deletePublicIp(publicIpId, { detachUnusedNic = false } = {}) {
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

  async deleteInstance(instanceId) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    if (!parsed.resourceGroup || !parsed.resourceName) {
      throw new Error(`无法识别 Azure 实例 ID: ${instanceId}`)
    }

    await this.computeClient.virtualMachines.beginDeleteAndWait(parsed.resourceGroup, parsed.resourceName)
    return { instanceId }
  }

  async instanceAction(instanceId, action) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    if (!parsed.resourceGroup || !parsed.resourceName) {
      throw new Error(`无法识别 Azure 实例 ID: ${instanceId}`)
    }

    switch (action) {
      case 'START':
        await this.computeClient.virtualMachines.beginStartAndWait(parsed.resourceGroup, parsed.resourceName)
        break
      case 'STOP':
        await this.computeClient.virtualMachines.beginPowerOffAndWait(parsed.resourceGroup, parsed.resourceName)
        break
      case 'REBOOT':
      case 'HARD_REBOOT':
        await this.computeClient.virtualMachines.beginRestartAndWait(parsed.resourceGroup, parsed.resourceName)
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

  _resolveSwitchIpTypes(options = {}) {
    const ipTypes = Array.isArray(options.ipTypes) && options.ipTypes.length ? options.ipTypes : ['ipv4']
    return {
      switchIpv4: ipTypes.includes('ipv4'),
      switchIpv6: ipTypes.includes('ipv6')
    }
  }

  async _findIpConfigurationForVersion(nic, ipVersion) {
    const configs = nic.ipConfigurations || []
    const target = String(ipVersion).toUpperCase()

    if (target === 'IPV4') {
      return configs.find((item) => item.primary && String(item.privateIPAddressVersion || 'IPv4').toUpperCase() !== 'IPV6') ||
        configs.find((item) => String(item.privateIPAddressVersion || 'IPv4').toUpperCase() !== 'IPV6') ||
        configs.find((item) => item.primary) ||
        configs[0] ||
        null
    }

    for (const config of configs) {
      if (String(config.privateIPAddressVersion || '').toUpperCase() === 'IPV6') {
        return config
      }

      if (config.publicIPAddress?.id) {
        const publicIp = await this._getPublicIpById(config.publicIPAddress.id).catch(() => null)
        if (String(publicIp?.publicIPAddressVersion || '').toUpperCase() === 'IPV6') {
          return config
        }
      }
    }

    return null
  }

  async _switchPublicIpVersion(instanceId, ipVersion) {
    await this._ensureInitialized()
    const vm = await this.getInstance(instanceId)
    const rawVm = vm.raw
    const primaryNicRef = rawVm.networkProfile?.networkInterfaces?.find((item) => item.primary) || rawVm.networkProfile?.networkInterfaces?.[0]

    if (!primaryNicRef?.id) {
      throw new Error('Azure 实例未绑定网卡，无法切换公网 IP')
    }

    const nic = await this._getNicById(primaryNicRef.id)
    const normalizedVersion = String(ipVersion).toLowerCase() === 'ipv6' ? 'IPv6' : 'IPv4'
    const ipConfig = await this._findIpConfigurationForVersion(nic, normalizedVersion)
    if (!ipConfig) {
      throw new Error(`Azure 网卡缺少 ${normalizedVersion} IP 配置`)
    }

    const oldPublicIpId = ipConfig.publicIPAddress?.id || ''
    const oldPublicIp = oldPublicIpId ? await this._getPublicIpById(oldPublicIpId).catch(() => null) : null
    const oldPublicIpVersion = String(oldPublicIp?.publicIPAddressVersion || normalizedVersion).toUpperCase()
    if (oldPublicIp && oldPublicIpVersion !== normalizedVersion.toUpperCase()) {
      throw new Error(`Azure 当前公网 IP 不是 ${normalizedVersion}`)
    }

    const publicIpParsed = oldPublicIpId ? parseAzureResourceId(oldPublicIpId) : parseAzureResourceId(nic.id)
    const nicParsed = parseAzureResourceId(nic.id)
    const publicIpName = `${safeName(rawVm.name || nic.name || 'vm')}-pip-${normalizedVersion.toLowerCase()}-${randomSuffix(5)}`

    const newPublicIp = await this.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(
      publicIpParsed.resourceGroup || nicParsed.resourceGroup,
      publicIpName,
      {
        location: nic.location || rawVm.location,
        publicIPAllocationMethod: oldPublicIp?.publicIPAllocationMethod || 'Static',
        publicIPAddressVersion: normalizedVersion,
        sku: { name: oldPublicIp?.sku?.name || 'Standard' },
        tags: { managedBy: 'cloud-manager', rotatedFrom: oldPublicIp?.name || '' }
      }
    )

    ipConfig.publicIPAddress = { id: newPublicIp.id }
    await this._updateNic(nic)

    if (oldPublicIp?.id) {
      const oldParsed = parseAzureResourceId(oldPublicIp.id)
      try {
        await this.networkClient.publicIPAddresses.beginDeleteAndWait(oldParsed.resourceGroup, oldParsed.resourceName)
      } catch (_) {
      }
    }

    if (normalizedVersion === 'IPv6') {
      return {
        newIpv6: newPublicIp.ipAddress,
        oldIpv6: oldPublicIp?.ipAddress || null
      }
    }

    return {
      newIpv4: newPublicIp.ipAddress,
      oldIpv4: oldPublicIp?.ipAddress || null
    }
  }

  async switchPublicIp(instanceId, options = {}) {
    const { switchIpv4, switchIpv6 } = this._resolveSwitchIpTypes(options)
    const result = { switchedTypes: [] }

    if (switchIpv4) {
      Object.assign(result, await this._switchPublicIpVersion(instanceId, 'ipv4'))
      result.switchedTypes.push('ipv4')
    }

    if (switchIpv6) {
      Object.assign(result, await this._switchPublicIpVersion(instanceId, 'ipv6'))
      result.switchedTypes.push('ipv6')
    }

    return {
      ...result,
      newIp: result.newIpv4 || result.newIpv6 || null,
      oldIp: result.oldIpv4 || result.oldIpv6 || null
    }
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
