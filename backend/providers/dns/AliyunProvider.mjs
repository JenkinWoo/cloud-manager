import BaseDnsProvider from './BaseDnsProvider.mjs'

let cachedSdk = null

async function loadSdk() {
  if (cachedSdk) return cachedSdk

  const sdkModule = await import('@alicloud/alidns20150109')
  const AlidnsClient = sdkModule?.default?.default

  if (typeof AlidnsClient !== 'function') {
    throw new Error('无法加载阿里云 DNS SDK，请确认 @alicloud/alidns20150109 已正确安装')
  }

  cachedSdk = {
    Client: AlidnsClient,
    DescribeDomainRecordsRequest: sdkModule.DescribeDomainRecordsRequest,
    AddDomainRecordRequest: sdkModule.AddDomainRecordRequest,
    UpdateDomainRecordRequest: sdkModule.UpdateDomainRecordRequest,
    DeleteDomainRecordRequest: sdkModule.DeleteDomainRecordRequest
  }

  return cachedSdk
}

export default class AliyunProvider extends BaseDnsProvider {
  static providerName = 'aliyun'

  constructor(dnsAccount) {
    super(dnsAccount)

    const { accessKeyId, accessKeySecret, domainName } = dnsAccount.credentials || {}
    if (!accessKeyId || !accessKeySecret) {
      throw new Error('阿里云 DNS 缺少 accessKeyId 或 accessKeySecret')
    }
    if (!domainName) {
      throw new Error('阿里云 DNS 缺少 domainName，请填写主域名，例如 example.com')
    }

    this.accessKeyId = accessKeyId
    this.accessKeySecret = accessKeySecret
    this.domainName = String(domainName).trim().toLowerCase().replace(/\.$/, '')
    this.clientPromise = null
  }

  async _getClient() {
    if (!this.clientPromise) {
      this.clientPromise = loadSdk().then(({ Client }) => new Client({
        accessKeyId: this.accessKeyId,
        accessKeySecret: this.accessKeySecret,
        endpoint: 'alidns.aliyuncs.com'
      }))
    }

    return this.clientPromise
  }

  _normalizeFullName(fullName) {
    const normalized = String(fullName || '').trim().toLowerCase().replace(/\.$/, '')
    if (!normalized) {
      throw new Error('请提供记录名称')
    }

    if (normalized === '@') return this.domainName
    if (normalized === this.domainName) return this.domainName

    const suffix = `.${this.domainName}`
    if (normalized.endsWith(suffix)) return normalized

    if (String(fullName || '').trim().endsWith('.')) {
      throw new Error(`记录 "${normalized}" 不属于主域名 ${this.domainName}`)
    }

    return `${normalized}${suffix}`
  }

  _extractSubdomain(fullName) {
    const normalized = this._normalizeFullName(fullName)
    if (normalized === this.domainName) return '@'

    const suffix = `.${this.domainName}`
    return normalized.slice(0, -suffix.length) || '@'
  }

  _normalizeRecord(record) {
    const rr = record.RR === '@' ? '' : `${String(record.RR).toLowerCase()}.`
    return {
      id: record.recordId,
      name: `${rr}${this.domainName}`,
      content: record.value,
      type: record.type,
      ttl: record.TTL,
      proxied: false
    }
  }

  async listRecords(filters = {}) {
    const client = await this._getClient()
    const { DescribeDomainRecordsRequest } = await loadSdk()

    const type = filters.type ? String(filters.type).trim() : undefined
    const rrKeyword = filters.name ? this._extractSubdomain(filters.name) : undefined

    const records = []
    let pageNumber = 1
    const pageSize = 500

    while (true) {
      const request = new DescribeDomainRecordsRequest({
        domainName: this.domainName,
        pageNumber,
        pageSize,
        type,
        RRKeyWord: rrKeyword,
        searchMode: rrKeyword ? 'ADVANCED' : undefined
      })

      const response = await client.describeDomainRecords(request)
      const body = response?.body || {}
      const pageRecords = body.domainRecords?.record || []

      records.push(...pageRecords.map((record) => this._normalizeRecord(record)))

      if (records.length >= (body.totalCount || 0) || pageRecords.length < pageSize) {
        break
      }

      pageNumber += 1
    }

    if (!filters.name) return records

    const normalizedName = this._normalizeFullName(filters.name)
    return records.filter((record) => record.name === normalizedName)
  }

  async upsertRecord(name, content, type = 'A', options = {}) {
    const client = await this._getClient()
    const { AddDomainRecordRequest, UpdateDomainRecordRequest } = await loadSdk()

    const normalizedName = this._normalizeFullName(name)
    const rr = this._extractSubdomain(normalizedName)
    const ttl = Number.isFinite(Number(options.ttl)) && Number(options.ttl) > 0
      ? Number(options.ttl)
      : undefined
    const line = options.line ? String(options.line).trim() : 'default'
    const priority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : undefined

    const existing = (await this.listRecords({ name: normalizedName, type }))[0]

    if (existing) {
      const request = new UpdateDomainRecordRequest({
        recordId: existing.id,
        RR: rr,
        type,
        value: content,
        line,
        TTL: ttl,
        priority
      })

      await client.updateDomainRecord(request)
      return { id: existing.id, name: normalizedName, content, type, upserted: true, action: 'updated' }
    }

    const request = new AddDomainRecordRequest({
      domainName: this.domainName,
      RR: rr,
      type,
      value: content,
      line,
      TTL: ttl,
      priority
    })

    const response = await client.addDomainRecord(request)
    return {
      id: response?.body?.recordId,
      name: normalizedName,
      content,
      type,
      upserted: true,
      action: 'created'
    }
  }

  async deleteRecord(name, type = 'A') {
    const client = await this._getClient()
    const { DeleteDomainRecordRequest } = await loadSdk()

    const normalizedName = this._normalizeFullName(name)
    const existing = (await this.listRecords({ name: normalizedName, type }))[0]
    if (!existing) return { deleted: false, reason: '记录不存在' }

    const request = new DeleteDomainRecordRequest({ recordId: existing.id })
    await client.deleteDomainRecord(request)

    return { deleted: true, id: existing.id }
  }
}
