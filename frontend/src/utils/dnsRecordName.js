export function normalizeDomainName(name) {
  return String(name || '').trim().toLowerCase().replace(/\.$/, '')
}

export function toFullRecordName(input, domain) {
  const raw = String(input || '').trim().toLowerCase()
  const name = normalizeDomainName(raw)
  const domainName = normalizeDomainName(domain)
  if (!name || !domainName) return name
  if (name === '@' || name === domainName) return domainName

  const suffix = `.${domainName}`
  if (name.endsWith(suffix)) return name
  if (raw.endsWith('.')) {
    throw new Error(`记录 "${name}" 不属于主域名 ${domainName}`)
  }
  return `${name}${suffix}`
}

export function toShortRecordName(input, domain) {
  const raw = String(input || '').trim().toLowerCase()
  const name = normalizeDomainName(raw)
  const domainName = normalizeDomainName(domain)
  if (!name || !domainName) return raw
  if (name === domainName) return '@'
  const suffix = `.${domainName}`
  if (name.endsWith(suffix)) return name.slice(0, -suffix.length) || '@'
  // Keep an explicit absolute name intact so blur cannot bypass zone validation.
  return raw
}
