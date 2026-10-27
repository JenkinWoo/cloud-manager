import { AZURE_FREE_VM_PROFILES } from './azureCostPolicy.mjs'

const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
// Explicit Free meters attest only to billed usage in this month, not to future
// eligibility or expiry. Never infer eligibility from a zero bill or user flags.
export function getAzureFreeBenefits(rows) {
  const vmRegions = []
  const diskRegions = new Set()
  for (const row of rows) {
    if (row.amount !== 0 || !(row.usage > 0) || !Number.isFinite(row.usage)) continue
    const location = normalize(row.region)
    if (!location) continue
    const meter = normalize(row.meter)
    if (/virtual machines|microsoft.compute/i.test(row.service) && /^(?:1\s*)?hours?$/i.test(row.unit?.trim())) {
      const vmSize = Object.keys(AZURE_FREE_VM_PROFILES).find(size => meter === normalize(size.replace('Standard_', '')) + 'free')
      if (vmSize && !vmRegions.some(item => item.vmSize === vmSize && item.location === location)) vmRegions.push({ vmSize, location })
    }
    if (/storage|microsoft.compute/i.test(row.service) && meter === 'p6lrsdiskfree' && /^(?:1\s*\/?\s*)?months?$/i.test(row.unit?.trim())) diskRegions.add(location)
  }
  // Published plan ceilings are conservative application limits, not balances
  // fetched from Azure. Keep that distinction in the API and UI.
  return { source: 'current-month-free-meters', vmRegions, diskRegions: [...diskRegions], monthlyVmHours: 750, monthlyP6Disks: 2 }
}

export const isP6Disk = disk => disk.sku?.name === 'Premium_LRS' &&
  (disk.tier === 'P6' || (!disk.tier && disk.diskSizeGB > 32 && disk.diskSizeGB <= 64))

export function azureFreeAllocationReason({ benefit, rows, inventory, location, vmSize, vmId = '', diskId = '', now = new Date() }) {
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const vmRows = rows.filter(row => /virtual machines|microsoft.compute/i.test(row.service) &&
    normalize(row.meter).replace(/free$/, '') === normalize(vmSize.replace('Standard_', '')))
  const diskRows = rows.filter(row => /storage|microsoft.compute/i.test(row.service) && /^p6lrsdisk(?:free)?$/.test(normalize(row.meter)))
  if (vmRows.some(row => row.amount > 0)) return '本月此机型已有实际计算费用，不能通过切换区域继续消耗共享免费额度'
  if (diskRows.some(row => row.amount > 0)) return '本月 P6 LRS 磁盘已有实际费用，无法确认剩余免费磁盘额度'
  if (vmRows.some(row => !Number.isFinite(row.usage) || row.usage < 0 || !/^(?:1\s*)?hours?$/i.test(row.unit?.trim())) ||
      diskRows.some(row => !Number.isFinite(row.usage) || row.usage < 0 || !/^(?:1\s*\/?\s*)?months?$/i.test(row.unit?.trim()))) {
    return '免费资源用量或计量单位不完整，无法核实剩余额度'
  }
  if (!benefit.vmRegions.some(item => item.vmSize === vmSize && item.location === normalize(location))) {
    return '本月账单没有此区域、机型的 Free 计算记录，暂不推荐；新订阅或账单未入账时也会出现此提示'
  }
  if (!benefit.diskRegions.includes(normalize(location))) return '本月账单没有此区域的 P6 LRS Disk - Free 记录，暂不推荐新增磁盘'
  if (inventory.vms.some(vm => vm.id?.toLowerCase() !== vmId.toLowerCase() && vm.hardwareProfile?.vmSize === vmSize)) {
    return `订阅中已有 ${vmSize} 实例；同规格实例跨区域共享月度免费额度`
  }
  const disks = inventory.disks.filter(disk => disk.id?.toLowerCase() !== diskId.toLowerCase() && isP6Disk(disk))
  if (disks.length >= benefit.monthlyP6Disks) return '订阅中的 P6 磁盘（含未挂载磁盘）已占满免费数量'
  const remainingHours = (monthEnd - now) / 3600000
  if (vmRows.reduce((sum, row) => sum + row.usage, 0) + remainingHours > benefit.monthlyVmHours) {
    return '本月剩余免费计算小时数不足以支持新实例运行至月底'
  }
  const monthHours = (monthEnd - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / 3600000
  if (diskRows.reduce((sum, row) => sum + row.usage, 0) + (disks.length + 1) * remainingHours / monthHours > benefit.monthlyP6Disks) {
    return '本月剩余 P6 免费磁盘用量不足以支持新增磁盘保留至月底'
  }
  return ''
}
