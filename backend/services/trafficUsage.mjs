import { trafficUsageDb } from '../db.mjs'

function pad2(value) {
  return String(value).padStart(2, '0')
}

export function getCurrentMonthPeriod(now = new Date()) {
  const startTime = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  return {
    monthKey: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`,
    startTime,
    endTime: now
  }
}

function normalizeBytes(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.max(0, Math.round(numeric))
}

function sumBytes(items, field) {
  return items.reduce((sum, item) => {
    const value = normalizeBytes(item[field])
    return value === null ? sum : sum + value
  }, 0)
}

function normalizeIpList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : []
}

function getUsageValue(usage, fields) {
  for (const field of fields) {
    if (usage && usage[field] !== undefined && usage[field] !== null) return usage[field]
  }
  return null
}

function normalizeProviderUsageMap(rawUsage) {
  if (rawUsage instanceof Map) return rawUsage
  if (rawUsage && typeof rawUsage === 'object') {
    return new Map(Object.entries(rawUsage))
  }
  return new Map()
}

function createInstanceRecord({ account, instance, monthKey, periodStart, periodEnd, usage, existing, nowIso }) {
  const inBytes = normalizeBytes(getUsageValue(usage, [
    'inBytes',
    'networkInBytes',
    'networkInBytesMonth',
    'networkInBytes24h'
  ]))
  const outBytes = normalizeBytes(getUsageValue(usage, [
    'outBytes',
    'networkOutBytes',
    'networkOutBytesMonth',
    'networkOutBytes24h'
  ]))
  const hasMetricData = inBytes !== null || outBytes !== null
  const canReuseExistingMetrics = existing?.metricStatus === 'ok'

  return {
    ...(existing || {}),
    accountId: account.id,
    accountName: account.name || '',
    provider: account.computeProvider,
    monthKey,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    instanceId: instance.id,
    displayName: instance.displayName || instance.name || instance.id,
    region: instance.region || '',
    zone: instance.zone || '',
    state: instance.state || 'UNKNOWN',
    publicIps: normalizeIpList(instance.publicIps),
    privateIps: normalizeIpList(instance.privateIps),
    ipv6Addresses: normalizeIpList(instance.ipv6Addresses),
    networkInBytesMonth: inBytes ?? (canReuseExistingMetrics ? existing?.networkInBytesMonth : null) ?? null,
    networkOutBytesMonth: outBytes ?? (canReuseExistingMetrics ? existing?.networkOutBytesMonth : null) ?? null,
    metricStatus: hasMetricData ? 'ok' : 'unavailable',
    deleted: false,
    firstSeenAt: existing?.firstSeenAt || nowIso,
    lastSeenAt: nowIso,
    deletedAt: null,
    updatedAt: nowIso
  }
}

function normalizeDeletedRecord(record, periodEnd, nowIso) {
  return {
    ...record,
    periodEnd: periodEnd.toISOString(),
    deleted: true,
    state: record.state === 'TERMINATED' ? record.state : 'DELETED',
    deletedAt: record.deletedAt || nowIso,
    updatedAt: nowIso
  }
}

function sortUsageRecords(left, right) {
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1
  const leftOut = normalizeBytes(left.networkOutBytesMonth) || 0
  const rightOut = normalizeBytes(right.networkOutBytesMonth) || 0
  if (leftOut !== rightOut) return rightOut - leftOut
  return String(left.displayName || left.instanceId).localeCompare(String(right.displayName || right.instanceId))
}

export async function syncTrafficUsage(account, provider, options = {}) {
  const { monthKey, startTime, endTime } = options.monthKey
    ? options
    : getCurrentMonthPeriod(options.now ? new Date(options.now) : new Date())
  const nowIso = new Date().toISOString()

  trafficUsageDb.data ||= { records: [] }
  trafficUsageDb.data.records ||= []

  const currentInstances = await provider.listInstances()
  const currentIds = currentInstances.map((item) => item.id).filter(Boolean)

  let metricsError = ''
  let usageMap = new Map()
  if (typeof provider.getNetworkUsage === 'function' && currentIds.length) {
    try {
      usageMap = normalizeProviderUsageMap(await provider.getNetworkUsage(currentIds, { startTime, endTime }))
    } catch (err) {
      metricsError = err.message || '网络流量指标获取失败'
      usageMap = new Map()
    }
  } else if (currentIds.length) {
    metricsError = '当前云厂商暂不支持月度流量指标'
  }

  const existingRecords = trafficUsageDb.data.records.filter(
    (record) => record.accountId === account.id && record.monthKey === monthKey
  )
  const existingByInstanceId = new Map(existingRecords.map((record) => [record.instanceId, record]))

  const updatedCurrentRecords = currentInstances
    .filter((instance) => instance.id)
    .map((instance) => createInstanceRecord({
      account,
      instance,
      monthKey,
      periodStart: startTime,
      periodEnd: endTime,
      usage: usageMap.get(instance.id) || {},
      existing: existingByInstanceId.get(instance.id),
      nowIso
    }))

  const currentIdSet = new Set(currentIds)
  const deletedRecords = existingRecords
    .filter((record) => !currentIdSet.has(record.instanceId))
    .map((record) => normalizeDeletedRecord(record, endTime, nowIso))

  const nextMonthRecords = [...updatedCurrentRecords, ...deletedRecords].sort(sortUsageRecords)
  const otherRecords = trafficUsageDb.data.records.filter(
    (record) => !(record.accountId === account.id && record.monthKey === monthKey)
  )

  trafficUsageDb.data.records = [...otherRecords, ...nextMonthRecords]
  await trafficUsageDb.write()

  return {
    account: {
      id: account.id,
      name: account.name || '',
      provider: account.computeProvider
    },
    monthKey,
    periodStart: startTime.toISOString(),
    periodEnd: endTime.toISOString(),
    totalInBytes: sumBytes(nextMonthRecords, 'networkInBytesMonth'),
    totalOutBytes: sumBytes(nextMonthRecords, 'networkOutBytesMonth'),
    currentInstanceCount: updatedCurrentRecords.length,
    deletedInstanceCount: deletedRecords.length,
    metricsUnavailableCount: nextMonthRecords.filter((record) => !record.deleted && record.metricStatus !== 'ok').length,
    metricsError,
    items: nextMonthRecords
  }
}
