export function billingNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export async function withBillingNetworkRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() } catch (error) {
      let cause = error
      let network = false
      while (cause) {
        if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(cause.code)) network = true
        if (cause.cause === cause) break
        cause = cause.cause
      }
      if (!network || attempt >= 2) throw error
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000))
    }
  }
}

export function billingTotals(rows) {
  const totals = new Map()
  for (const row of rows) {
    if (billingNumber(row.amount) === null) throw new Error('账单接口返回的费用缺失或无效')
    const currency = String(row.currency || '').trim() || '未知币种'
    totals.set(currency, (totals.get(currency) || 0) + Number(row.amount))
  }
  const amounts = [...totals].map(([currency, amount]) => ({ currency, amount }))
  return { totals: amounts, total: amounts.length === 1 ? amounts[0].amount : null, currency: amounts.length === 1 ? amounts[0].currency : null }
}

export function groupBillingRows(rows) {
  const groups = new Map()
  for (const row of rows) {
    if (billingNumber(row.amount) === null) throw new Error('账单接口返回的费用缺失或无效')
    // Preserve dated line items: merging different usage periods hides when a
    // charge occurred and incorrectly makes gaps look like continuous usage.
    const key = JSON.stringify([row.service, row.meter, row.resource, row.region, row.unit, row.currency, row.unitPrice, row.chargeType,
      row.periodStart || null, row.periodEnd || null, row.periodEndExclusive === true])
    const current = groups.get(key)
    if (!current) groups.set(key, { ...row })
    else {
      current.amount += row.amount
      current.usage = current.usage === null || row.usage === null ? null : current.usage + row.usage
    }
  }
  return [...groups.values()].sort((a, b) => b.amount - a.amount)
}
