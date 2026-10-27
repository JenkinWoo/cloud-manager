// Official free VM allowance: https://azure.microsoft.com/en-us/free/students/
// These are free-tier configurations, not proof of an unlimited entitlement.
export const AZURE_FREE_VM_PROFILES = Object.freeze({
  Standard_B1s: Object.freeze({ architecture: 'x64', imageSku: '22_04-lts-gen2' }),
  Standard_B2ats_v2: Object.freeze({ architecture: 'x64', imageSku: '22_04-lts-gen2' }),
  Standard_B2pts_v2: Object.freeze({ architecture: 'Arm64', imageSku: '22_04-lts-arm64' })
})

export const AZURE_COST_POLICY = Object.freeze({
  mode: 'free-vm-optional-paid-ip', creationAllowed: true, startAllowed: true, publicIpAllowed: true,
  publicIp: Object.freeze({ sku: 'Standard', allocationMethod: 'Static', version: 'IPv4', chargeable: true, defaultEnabled: false }),
  vmSizes: Object.keys(AZURE_FREE_VM_PROFILES),
  osDisk: Object.freeze({ storageAccountType: 'Premium_LRS', diskSizeGB: 64, tier: 'P6' }),
  reason: '自动按当前订阅本月的 Free 计费记录、用量和现有资源筛选区域及机型，固定 Ubuntu 与 64 GiB P6 系统盘；默认私网，仅公网 IPv4 可选付费。无需手填权益。历史免费记录不保证后续免费，实际权益有效期及剩余额度以 Azure 为准。'
})

export function azureFreeOnlyError(message) {
  return Object.assign(new Error(message), { code: 'FreeOnlyMode', statusCode: 403, retryable: false })
}

export function getAzureFreeVmProfile(vmSize = 'Standard_B2ats_v2') {
  if (!Object.hasOwn(AZURE_FREE_VM_PROFILES, vmSize)) {
    throw azureFreeOnlyError('仅允许免费额度规格：B1s、B2ats v2、B2pts v2')
  }
  return AZURE_FREE_VM_PROFILES[vmSize]
}

export function validateAzureFreeCreateParams(params = {}) {
  const vmSize = params.vmSize || 'Standard_B2ats_v2'
  const profile = getAzureFreeVmProfile(vmSize)
  const image = { publisher: 'Canonical', offer: '0001-com-ubuntu-server-jammy', sku: profile.imageSku, version: 'latest' }
  for (const [key, value] of Object.entries(image)) {
    const field = 'image' + key[0].toUpperCase() + key.slice(1)
    if (params[field] != null && params[field] !== '' && params[field] !== value) {
      throw azureFreeOnlyError(`免费模式使用与 ${profile.architecture} 匹配的 Ubuntu 镜像，不允许自定义收费镜像`)
    }
  }
  for (const field of ['storageAccountType', 'osDiskStorageAccountType']) {
    if (params[field] != null && params[field] !== 'Premium_LRS') throw azureFreeOnlyError('免费模式系统盘仅允许 Premium_LRS P6')
  }
  for (const field of ['diskSizeGB', 'osDiskSizeGB']) {
    if (params[field] != null && Number(params[field]) !== 64) throw azureFreeOnlyError('免费模式系统盘固定为 64 GiB P6')
  }
  const ipFields = ['publicIp', 'assignPublicIp', 'createPublicIp', 'publicIpEnabled']
  for (const field of ipFields) {
    if (params[field] != null && ![true, 'true', false, 'false', 'none', ''].includes(params[field])) {
      throw Object.assign(new Error('公网 IP 选项必须为 true 或 false'), { statusCode: 400, retryable: false })
    }
  }
  const createPublicIp = ipFields.some(field => [true, 'true'].includes(params[field]))
  return { vmSize, ...profile, image, osDisk: AZURE_COST_POLICY.osDisk, createPublicIp }
}

export function assertAzureFreeSubscription(subscription = {}) {
  const quotaId = subscription.subscriptionPolicies?.quotaId || ''
  if (String(subscription.state).toLowerCase() !== 'enabled' ||
      !/^(AzureForStudents_|FreeTrial_|Free_)/i.test(quotaId)) {
    throw azureFreeOnlyError('请选择有效的 Azure 学生或免费试用订阅')
  }
}

// Serialize allocations so concurrent tasks check inventory after the preceding
// allocation has completed. The lock covers all regions of one subscription.
const allocationLocks = new Map()
export async function withAzureAllocationLock(subscriptionId, operation) {
  const key = subscriptionId.toLowerCase()
  const previous = allocationLocks.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  allocationLocks.set(key, current)
  try { return await current } finally { if (allocationLocks.get(key) === current) allocationLocks.delete(key) }
}
