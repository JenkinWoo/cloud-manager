import axios from 'axios'
import { createHash, createHmac } from 'crypto'
import BaseDnsProvider from './BaseDnsProvider.mjs'

const API_BASE_URL = 'https://dns.myhuaweicloud.com'
const API_HOST = 'dns.myhuaweicloud.com'
const DEFAULT_TTL = 600
const MANAGEABLE_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT'])

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function formatSdkDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function normalizeDomainName(domainName) {
  return String(domainName || '').trim().toLowerCase().replace(/\.$/, '')
}

export default class HuaweiCloudProvider extends BaseDnsProvider {
  static providerName = 'Huawei Cloud DNS'

  constructor(dnsAccount) {
    super(dnsAccount)

    const { accessKeyId, secretAccessKey, domainName } = dnsAccount.credentials || {}
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('华为云 DNS 缺少 Access Key ID 或 Secret Access Key')
    }
    if (!domainName) {
      throw new Error('华为云 DNS 缺少 domainName，请填写主域名，例如 example.com')
    }

    this.accessKeyId = accessKeyId
    this.secretAccessKey = secretAccessKey
    this.domainName = normalizeDomainName(domainName)
    this.zonePromise = null
    this.api = axios.create({
      baseURL: API_BASE_URL
    })
  }

  _normalizeFullName(fullName) {
    const normalized = normalizeDomainName(fullName)
    if (!normalized) {
      throw new Error('请提供记录名称')
    }

    if (normalized === '@') return this.domainName
    if (normalized === this.domainName) return this.domainName

    const suffix = `.${this.domainName}`
    if (normalized.endsWith(suffix)) return normalized

    if (normalized.includes('.')) {
      throw new Error(`记录 "${normalized}" 不属于主域名 ${this.domainName}`)
    }

    return `${normalized}${suffix}`
  }

  _buildQueryString(query = {}) {
    return Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey === rightKey) return leftValue.localeCompare(rightValue)
        return leftKey.localeCompare(rightKey)
      })
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
  }

  _normalizeRequestPath(path) {
    let normalized = String(path || '').trim()
    if (!normalized) return '/'
    if (!normalized.startsWith('/')) {
      normalized = `/${normalized}`
    }
    if (normalized === '/') return normalized

    // 华为云 DNS 网关验签时会把资源路径规范化为带尾斜杠的 Canonical URI，
    // 但实际请求仍然要走原始 API 路径，否则可能返回 API 不存在。
    return normalized.endsWith('/') ? normalized : `${normalized}/`
  }

  async _request(method, path, { query = {}, body = undefined } = {}) {
    const payload = body ? JSON.stringify(body) : ''
    const xSdkDate = formatSdkDate()
    const requestPath = String(path || '').trim() || '/'
    const normalizedPath = this._normalizeRequestPath(path)
    const canonicalQuery = this._buildQueryString(query)
    const requestUrl = canonicalQuery ? `${requestPath}?${canonicalQuery}` : requestPath
    const headersToSign = {
      'content-type': 'application/json',
      host: API_HOST,
      'x-sdk-date': xSdkDate
    }
    const signedHeaders = Object.keys(headersToSign).sort()
    const canonicalHeaders = signedHeaders
      .map((key) => `${key}:${String(headersToSign[key]).trim()}\n`)
      .join('')
    const canonicalRequest = [
      method.toUpperCase(),
      normalizedPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders.join(';'),
      sha256Hex(payload)
    ].join('\n')
    const stringToSign = [
      'SDK-HMAC-SHA256',
      xSdkDate,
      sha256Hex(canonicalRequest)
    ].join('\n')
    const signature = createHmac('sha256', this.secretAccessKey).update(stringToSign).digest('hex')
    const authorization = [
      `Access=${this.accessKeyId}`,
      `SignedHeaders=${signedHeaders.join(';')}`,
      `Signature=${signature}`
    ].join(', ')

    try {
      const response = await this.api.request({
        method,
        url: requestUrl,
        data: body,
        headers: {
          Authorization: `SDK-HMAC-SHA256 ${authorization}`,
          'Content-Type': 'application/json',
          Host: API_HOST,
          'X-Sdk-Date': xSdkDate
        }
      })

      return response.data
    } catch (error) {
      const data = error.response?.data
      if (data?.error_code || data?.error_msg || data?.code || data?.message) {
        const code = data.error_code || data.code || 'HuaweiCloudError'
        const message = data.error_msg || data.message || '请求失败'
        throw new Error(`${code}: ${message}`)
      }
      if (typeof data === 'string' && data.trim()) {
        throw new Error(data.trim())
      }
      throw error
    }
  }

  async _getZone() {
    if (!this.zonePromise) {
      this.zonePromise = this._request('GET', '/v2/zones', {
        query: {
          name: `${this.domainName}.`,
          type: 'public'
        }
      }).then((data) => {
        const zones = Array.isArray(data?.zones) ? data.zones : []
        const zone = zones.find((item) => normalizeDomainName(item.name) === this.domainName)
        if (!zone) {
          throw new Error(`未找到华为云公网域名 ${this.domainName}`)
        }
        return zone
      })
    }

    return this.zonePromise
  }

  _normalizeRecordset(recordset) {
    const records = Array.isArray(recordset.records) && recordset.records.length > 0
      ? recordset.records
      : ['']

    return records.map((value, index) => ({
      id: records.length > 1 ? `${recordset.id}:${index}` : recordset.id,
      recordsetId: recordset.id,
      name: normalizeDomainName(recordset.name),
      content: value,
      type: recordset.type,
      ttl: recordset.ttl,
      proxied: false
    }))
  }

  async listRecords(filters = {}) {
    const zone = await this._getZone()
    const records = []
    const limit = 500
    let offset = 0

    while (true) {
      const response = await this._request('GET', `/v2/zones/${zone.id}/recordsets`, {
        query: {
          limit,
          offset,
          ...(filters.type ? { type: String(filters.type).trim().toUpperCase() } : {}),
          ...(filters.name ? { name: `${this._normalizeFullName(filters.name)}.` } : {})
        }
      })

      const page = Array.isArray(response?.recordsets) ? response.recordsets : []
      records.push(...page.flatMap((recordset) => this._normalizeRecordset(recordset)))

      if (page.length < limit || filters.name) {
        break
      }

      offset += page.length
    }

    if (!filters.name) return records

    const normalizedName = this._normalizeFullName(filters.name)
    return records.filter((record) => record.name === normalizedName)
  }

  async upsertRecord(name, content, type = 'A', options = {}) {
    const zone = await this._getZone()
    const normalizedName = this._normalizeFullName(name)
    const ttl = Number.isFinite(Number(options.ttl)) && Number(options.ttl) > 0
      ? Number(options.ttl)
      : DEFAULT_TTL
    const existing = (await this.listRecords({ name: normalizedName, type }))[0]
    const payload = {
      name: `${normalizedName}.`,
      type,
      ttl,
      records: [content]
    }

    if (existing) {
      await this._request('PUT', `/v2/zones/${zone.id}/recordsets/${existing.recordsetId || existing.id}`, {
        body: payload
      })

      return { id: existing.recordsetId || existing.id, name: normalizedName, content, type, upserted: true, action: 'updated' }
    }

    const response = await this._request('POST', `/v2/zones/${zone.id}/recordsets`, {
      body: payload
    })

    return {
      id: response?.id,
      name: normalizedName,
      content,
      type,
      upserted: true,
      action: 'created'
    }
  }

  async deleteRecord(name, type = 'A') {
    const zone = await this._getZone()
    const normalizedName = this._normalizeFullName(name)
    const existing = (await this.listRecords({ name: normalizedName, type }))[0]
    if (!existing) return { deleted: false, reason: '记录不存在' }
    if (!MANAGEABLE_RECORD_TYPES.has(String(existing.type || '').toUpperCase())) {
      throw new Error(`华为云 ${existing.type} 系统记录不支持在此处删除`)
    }

    await this._request('DELETE', `/v2/zones/${zone.id}/recordsets/${existing.recordsetId || existing.id}`)
    return { deleted: true, id: existing.recordsetId || existing.id }
  }
}
