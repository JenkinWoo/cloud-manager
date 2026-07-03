import axios from 'axios'
import { createHash, createHmac } from 'crypto'
import BaseDnsProvider from './BaseDnsProvider.mjs'

const API_BASE_URL = 'https://dnspod.tencentcloudapi.com'
const API_HOST = 'dnspod.tencentcloudapi.com'
const API_SERVICE = 'dnspod'
const API_VERSION = '2021-03-23'
const DEFAULT_TTL = 600

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key, value, encoding) {
  const digest = createHmac('sha256', key).update(value).digest()
  return encoding === 'hex' ? digest.toString('hex') : digest
}

export default class TencentCloudProvider extends BaseDnsProvider {
  static providerName = 'Tencent Cloud DNSPod'

  constructor(dnsAccount) {
    super(dnsAccount)

    const { secretId, secretKey, domainName } = dnsAccount.credentials || {}
    if (!secretId || !secretKey) {
      throw new Error('腾讯云 DNSPod 缺少 SecretId 或 SecretKey')
    }
    if (!domainName) {
      throw new Error('腾讯云 DNSPod 缺少 domainName，请填写主域名，例如 example.com')
    }

    this.secretId = secretId
    this.secretKey = secretKey
    this.domainName = String(domainName).trim().toLowerCase().replace(/\.$/, '')
    this.api = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    })
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

    if (normalized.includes('.')) {
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
    const rr = record.Name === '@' ? '' : `${String(record.Name).toLowerCase()}.`
    return {
      id: String(record.RecordId),
      name: `${rr}${this.domainName}`,
      content: record.Value,
      type: record.Type,
      ttl: record.TTL,
      proxied: false
    }
  }

  async _request(action, payload) {
    const timestamp = Math.floor(Date.now() / 1000)
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
    const body = JSON.stringify(payload)
    const canonicalHeaders = [
      'content-type:application/json; charset=utf-8',
      `host:${API_HOST}`,
      `x-tc-action:${action.toLowerCase()}`
    ].join('\n')

    const canonicalRequest = [
      'POST',
      '/',
      '',
      `${canonicalHeaders}\n`,
      'content-type;host;x-tc-action',
      sha256Hex(body)
    ].join('\n')

    const credentialScope = `${date}/${API_SERVICE}/tc3_request`
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(timestamp),
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join('\n')

    const secretDate = hmac(`TC3${this.secretKey}`, date)
    const secretService = hmac(secretDate, API_SERVICE)
    const secretSigning = hmac(secretService, 'tc3_request')
    const signature = hmac(secretSigning, stringToSign, 'hex')

    const authorization = [
      'TC3-HMAC-SHA256',
      `Credential=${this.secretId}/${credentialScope}`,
      'SignedHeaders=content-type;host;x-tc-action',
      `Signature=${signature}`
    ].join(' ')

    try {
      const response = await this.api.post('/', payload, {
        headers: {
          Authorization: authorization,
          Host: API_HOST,
          'X-TC-Action': action,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Version': API_VERSION
        }
      })

      const bodyData = response?.data?.Response || {}
      if (bodyData.Error) {
        throw new Error(`${bodyData.Error.Code}: ${bodyData.Error.Message}`)
      }

      return bodyData
    } catch (error) {
      const apiError = error.response?.data?.Response?.Error
      if (apiError) {
        throw new Error(`${apiError.Code}: ${apiError.Message}`)
      }
      throw error
    }
  }

  async listRecords(filters = {}) {
    const type = filters.type ? String(filters.type).trim().toUpperCase() : undefined
    const subdomain = filters.name ? this._extractSubdomain(filters.name) : undefined
    const records = []
    const limit = 100
    let offset = 0

    while (true) {
      let response
      try {
        response = await this._request('DescribeRecordList', {
          Domain: this.domainName,
          Offset: offset,
          Limit: limit,
          ...(subdomain ? { Subdomain: subdomain } : {}),
          ...(type ? { RecordType: type } : {})
        })
      } catch (error) {
        if (String(error.message || '').startsWith('ResourceNotFound.NoDataOfRecord:')) {
          return []
        }
        throw error
      }

      const pageRecords = Array.isArray(response.RecordList) ? response.RecordList : []
      records.push(...pageRecords.map((record) => this._normalizeRecord(record)))

      const totalCount = Number(response.RecordCountInfo?.TotalCount || 0)
      if (pageRecords.length < limit || (totalCount > 0 && records.length >= totalCount)) {
        break
      }

      offset += pageRecords.length
    }

    if (!filters.name) return records

    const normalizedName = this._normalizeFullName(filters.name)
    return records.filter((record) => record.name === normalizedName)
  }

  async upsertRecord(name, content, type = 'A', options = {}) {
    const normalizedName = this._normalizeFullName(name)
    const subDomain = this._extractSubdomain(normalizedName)
    const ttl = Number.isFinite(Number(options.ttl)) && Number(options.ttl) > 0
      ? Number(options.ttl)
      : DEFAULT_TTL
    const recordLine = String(options.line || '默认').trim() || '默认'
    const existing = (await this.listRecords({ name: normalizedName, type }))[0]

    if (existing) {
      await this._request('ModifyRecord', {
        Domain: this.domainName,
        RecordId: Number(existing.id),
        SubDomain: subDomain,
        RecordType: type,
        RecordLine: recordLine,
        Value: content,
        TTL: ttl
      })

      return { id: existing.id, name: normalizedName, content, type, upserted: true, action: 'updated' }
    }

    const response = await this._request('CreateRecord', {
      Domain: this.domainName,
      SubDomain: subDomain,
      RecordType: type,
      RecordLine: recordLine,
      Value: content,
      TTL: ttl
    })

    return {
      id: String(response.RecordId),
      name: normalizedName,
      content,
      type,
      upserted: true,
      action: 'created'
    }
  }

  async deleteRecord(name, type = 'A') {
    const normalizedName = this._normalizeFullName(name)
    const existing = (await this.listRecords({ name: normalizedName, type }))[0]
    if (!existing) return { deleted: false, reason: '记录不存在' }

    await this._request('DeleteRecord', {
      Domain: this.domainName,
      RecordId: Number(existing.id)
    })

    return { deleted: true, id: existing.id }
  }
}
