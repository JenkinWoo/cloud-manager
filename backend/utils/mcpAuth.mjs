import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { settingsDb } from '../db.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const config = () => settingsDb.data.mcp || { enabled: false, allowedOrigins: [], tokens: [] }

export function getMcpSettings() {
  const current = config()
  return { enabled: current.enabled === true, endpoint: '/mcp', transport: 'streamable-http',
    allowedOrigins: current.allowedOrigins || [],
    tokens: (current.tokens || []).map(({ id, name, mode, createdAt, expiresAt }) =>
      ({ id, name, mode, createdAt, expiresAt, expired: Date.parse(expiresAt) <= Date.now() })) }
}

// Serialize settings changes so concurrent creates/revocations are persisted in order.
let settingsChanges = Promise.resolve()
function updateConfig(operation) {
  const result = settingsChanges.catch(() => {}).then(async () => {
    const next = structuredClone(config())
    const value = operation(next)
    const previous = settingsDb.data.mcp
    settingsDb.data.mcp = next
    try { await settingsDb.write() } catch (error) { settingsDb.data.mcp = previous; throw error }
    return value
  })
  settingsChanges = result
  return result
}

export async function saveMcpSettings({ enabled, allowedOrigins }) {
  return updateConfig(next => {
    next.enabled = enabled
    next.allowedOrigins = [...new Set(allowedOrigins.map(value => {
      const url = new URL(value)
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value || value.includes('*') || url.username || url.password) {
        throw new Error('浏览器来源必须是完整 origin，例如 https://cloud.example.com，不含路径或通配符')
      }
      return url.origin
    }))]
  })
}

export async function createMcpToken({ name, mode, expiresInDays }) {
  return updateConfig(next => {
    next.tokens = (next.tokens || []).filter(token => Date.parse(token.expiresAt) > Date.now())
    if (next.tokens.length >= 20) throw new Error('最多保留 20 个有效 MCP 令牌，请先撤销不使用的令牌')
    const token = 'cm_mcp_' + randomBytes(32).toString('hex')
    const entry = { id: randomUUID(), name, mode, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + expiresInDays * 86400000).toISOString(), tokenHash: digest(token) }
    next.tokens.push(entry)
    const { tokenHash, ...metadata } = entry
    return { ...metadata, token }
  })
}

export async function revokeMcpToken(id) {
  return updateConfig(next => { next.tokens = (next.tokens || []).filter(token => token.id !== id) })
}

export function findMcpToken(authorization) {
  if (config().enabled !== true || typeof authorization !== 'string') return null
  const match = /^Bearer (cm_mcp_[a-f0-9]{64})$/i.exec(authorization)
  if (!match) return null
  const candidate = Buffer.from(digest(match[1]), 'hex')
  return (config().tokens || []).find(token => {
    if (!/^[a-f0-9]{64}$/.test(token.tokenHash || '') || !(Date.parse(token.expiresAt) > Date.now())) return false
    return timingSafeEqual(candidate, Buffer.from(token.tokenHash, 'hex'))
  }) || null
}
