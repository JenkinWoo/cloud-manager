// Keep usage dates in the provider's UTC billing calendar, independent of the
// browser timezone. Missing dates must not fall back to the query/refresh date.
function billingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null
  const day = new Date(value.slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return null
  const date = new Date(value.includes('T') && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value + 'Z' : value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function billingPeriod(row) {
  const start = billingDate(row.periodStart)
  let end = billingDate(row.periodEnd)
  if (row.periodEndExclusive && end) {
    if (start && end <= start) return '日期未提供'
    end = new Date(end.getTime() - 1)
  }
  const from = start?.toISOString().slice(0, 10)
  const to = end?.toISOString().slice(0, 10)
  if (from && to) return from === to ? from : `${from} 至 ${to}`
  if (from) return `${from} 起（结束日期未提供）`
  if (to) return `截至 ${to}（开始日期未提供）`
  return '日期未提供'
}

export function compareBillingDates(a, b) {
  const timestamp = row => {
    const start = billingDate(row.periodStart)
    const end = billingDate(row.periodEnd)
    const time = start?.getTime() ?? (end ? end.getTime() - (row.periodEndExclusive ? 1 : 0) : null)
    // Sort by the displayed UTC day; preserve the original order within a day.
    return time === null ? -Infinity : Math.floor(time / 86400000)
  }
  const left = timestamp(a)
  const right = timestamp(b)
  return left === right ? 0 : right - left
}

export function money(value, currency) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '暂无数据'
  const number = Number(value)
  const digits = number !== 0 && Math.abs(number) < 0.01 ? 8 : 4
  if (!currency) return `${number.toFixed(digits)}（币种未知）`
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: digits }).format(number) }
  catch { return `${number.toFixed(digits)} ${currency}` }
}
