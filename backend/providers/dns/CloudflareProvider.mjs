import axios from 'axios'
import BaseDnsProvider from './BaseDnsProvider.mjs'

export default class CloudflareProvider extends BaseDnsProvider {
  static providerName = 'cloudflare'

  constructor(dnsAccount) {
    super(dnsAccount)

    const { apiToken, zoneId, domainName } = dnsAccount.credentials || {}
    if (!apiToken || !zoneId) throw new Error('Cloudflare Provider 缺少 apiToken 或 zoneId')
    if (!domainName) throw new Error('Cloudflare Provider 缺少 domainName，请填写主域名，例如 frp.gs')

    this.zoneId = zoneId
    this.domainName = String(domainName).trim().toLowerCase().replace(/\.$/, '')
    this.api = axios.create({
      baseURL: 'https://api.cloudflare.com/client/v4',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    })
  }

  _normalizeName(name) {
    const normalized = String(name || '').trim().toLowerCase().replace(/\.$/, '')
    if (!normalized) throw new Error('请提供记录名称')
    if (normalized === '@') return this.domainName
    if (normalized === this.domainName) return this.domainName

    const suffix = `.${this.domainName}`
    if (normalized.endsWith(suffix)) return normalized
    // A trailing dot explicitly marks an absolute name; other dotted inputs
    // are valid multi-level names relative to this zone.
    if (String(name || '').trim().endsWith('.')) {
      throw new Error(`记录 "${normalized}" 不属于主域名 ${this.domainName}`)
    }

    return `${normalized}${suffix}`
  }

  async listRecords(filters = {}) {
    const params = {}
    if (filters.name) params.name = this._normalizeName(filters.name)
    if (filters.type) params.type = filters.type

    const res = await this.api.get(`/zones/${this.zoneId}/dns_records`, { params })
    return res.data.result.map(r => ({
      id: r.id,
      name: r.name,
      content: r.content,
      type: r.type,
      ttl: r.ttl,
      proxied: r.proxied
    }))
  }

  async upsertRecord(name, content, type = 'A', options = {}) {
    const { proxied = false, ttl = 1 } = options
    const normalizedName = this._normalizeName(name)
    const existing = (await this.listRecords({ name: normalizedName, type }))[0]
    const payload = { type, name: normalizedName, content, ttl, proxied }

    if (existing) {
      await this.api.put(`/zones/${this.zoneId}/dns_records/${existing.id}`, payload)
    } else {
      await this.api.post(`/zones/${this.zoneId}/dns_records`, payload)
    }

    return { name: normalizedName, content, type, upserted: true }
  }

  async deleteRecord(name, type = 'A') {
    const normalizedName = this._normalizeName(name)
    const existing = (await this.listRecords({ name: normalizedName, type }))[0]
    if (!existing) return { deleted: false, reason: '记录不存在' }

    await this.api.delete(`/zones/${this.zoneId}/dns_records/${existing.id}`)
    return { deleted: true, id: existing.id }
  }
}
