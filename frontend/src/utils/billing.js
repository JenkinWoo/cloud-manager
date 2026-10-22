export function money(value, currency) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '暂无数据'
  const number = Number(value)
  const digits = number !== 0 && Math.abs(number) < 0.01 ? 8 : 4
  if (!currency) return `${number.toFixed(digits)}（币种未知）`
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: digits }).format(number) }
  catch { return `${number.toFixed(digits)} ${currency}` }
}
