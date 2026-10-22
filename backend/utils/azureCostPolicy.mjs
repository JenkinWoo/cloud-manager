// Official free VM allowance: https://azure.microsoft.com/en-us/free/students/
// These are free-tier configurations, not proof of an unlimited entitlement.
export const AZURE_FREE_VM_PROFILES = Object.freeze({
  Standard_B1s: Object.freeze({ architecture: 'x64', imageSku: '22_04-lts-gen2' }),
  Standard_B2ats_v2: Object.freeze({ architecture: 'x64', imageSku: '22_04-lts-gen2' }),
  Standard_B2pts_v2: Object.freeze({ architecture: 'Arm64', imageSku: '22_04-lts-arm64' })
})

export const AZURE_COST_POLICY = Object.freeze({
  mode: 'free-only', creationAllowed: true, startAllowed: true, publicIpAllowed: false,
  vmSizes: Object.keys(AZURE_FREE_VM_PROFILES),
  osDisk: Object.freeze({ storageAccountType: 'Premium_LRS', diskSizeGB: 64, tier: 'P6' }),
  reason: '仅允许免费额度规格 B1s、B2ats v2 和 B2pts v2；默认使用 Ubuntu、64 GiB P6 系统盘和私网，不创建公网 IP。免费权益有有效期及月度用量上限。'
})

export function azureFreeOnlyError(message) {
  return Object.assign(new Error(message), { code: 'FreeOnlyMode', statusCode: 403, retryable: false })
}

export function getAzureFreeVmProfile(vmSize = 'Standard_B1s') {
  if (!Object.hasOwn(AZURE_FREE_VM_PROFILES, vmSize)) {
    throw azureFreeOnlyError('仅允许免费额度规格：B1s、B2ats v2、B2pts v2')
  }
  return AZURE_FREE_VM_PROFILES[vmSize]
}

export function validateAzureFreeCreateParams(params = {}) {
  const vmSize = params.vmSize || 'Standard_B1s'
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
  for (const field of ['publicIp', 'assignPublicIp', 'createPublicIp', 'publicIpEnabled']) {
    if (params[field] != null && ![false, 'false', 'none', ''].includes(params[field])) throw azureFreeOnlyError('免费模式不创建收费公网 IP')
  }
  return { vmSize, ...profile, image, osDisk: AZURE_COST_POLICY.osDisk }
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
