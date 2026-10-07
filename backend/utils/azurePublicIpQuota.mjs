// Creating a Standard regional IPv4 address consumes both quotas.
export function getAzurePublicIpQuota(usages, requiredAddresses = 1) {
  const names = ['PublicIPAddresses', 'IPv4StandardSkuPublicIpAddresses']
  let remainingAddresses = Infinity
  let unknown = false
  for (const name of names) {
    const usage = usages.find(item => item.name?.value?.toLowerCase() === name.toLowerCase())
    if (!usage || !Number.isFinite(usage.limit) || !Number.isFinite(usage.currentValue) || usage.limit < 0 || usage.currentValue < 0) {
      unknown = true
      continue
    }
    const remaining = Math.max(0, usage.limit - usage.currentValue)
    remainingAddresses = Math.min(remainingAddresses, remaining)
    if (remaining < requiredAddresses) {
      return { sufficient: false, remainingAddresses: remaining, requiredAddresses,
        reason: `公网 IP 配额不足（${name}）：上限 ${usage.limit} 个，已用 ${usage.currentValue} 个，本次需要 ${requiredAddresses} 个` }
    }
  }
  if (unknown) return { sufficient: null, requiredAddresses, reason: 'Azure 未返回完整的公网 IP 配额，请重新加载或检查订阅权限' }
  return { sufficient: true, remainingAddresses, requiredAddresses, reason: '' }
}
