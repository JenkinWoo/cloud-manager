export function getAzureVmQuota(sku, usages) {
  // Constrained-core sizes consume their full vCPUs quota, not vCPUsAvailable.
  const requiredCores = Number(sku.capabilities?.find(item => item.name === 'vCPUs')?.value)
  const family = sku.family || ''
  if (!family || !Number.isFinite(requiredCores) || requiredCores <= 0) {
    return { sufficient: null, reason: '规格缺少系列或 CPU 信息，无法确认配额' }
  }
  const findUsage = (name) => usages.find(item => item.name?.value?.toLowerCase() === name.toLowerCase())
  const checks = [{ label: `系列 ${family}`, usage: findUsage(family) }, { label: '区域总 CPU', usage: findUsage('cores') }]
  let remainingCores = Infinity
  let unknown = false
  for (const { label, usage } of checks) {
    if (!usage || !Number.isFinite(usage.limit) || !Number.isFinite(usage.currentValue) || usage.limit < 0 || usage.currentValue < 0) {
      unknown = true
      continue
    }
    const remaining = Math.max(0, usage.limit - usage.currentValue)
    remainingCores = Math.min(remainingCores, remaining)
    if (remaining < requiredCores) {
      return { sufficient: false, family, requiredCores, remainingCores: remaining,
        reason: `${label} 配额不足：上限 ${usage.limit} 核，已用 ${usage.currentValue} 核，本次需要 ${requiredCores} 核` }
    }
  }
  if (unknown) return { sufficient: null, family, requiredCores, reason: 'Azure 未返回完整的系列或区域 CPU 配额，请重新加载或检查订阅权限' }
  return { sufficient: true, family, requiredCores, remainingCores, reason: '' }
}
