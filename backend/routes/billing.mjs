import { Router } from 'express'
import { createHash } from 'node:crypto'
import { accountsDb } from '../db.mjs'
import { getComputeProvider } from '../providers/registry.mjs'

const router = Router()
const cache = new Map()
const pending = new Map()
const CACHE_TTL_MS = 10 * 60 * 1000

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new Error('日期必须使用 YYYY-MM-DD 格式')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('日期无效')
  return date
}

export function getPeriod(query) {
  const now = new Date()
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  const month = String(query.month || '').trim()
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month 必须使用 YYYY-MM 格式')
    const [year, monthNumber] = month.split('-').map(Number)
    const from = new Date(Date.UTC(year, monthNumber - 1, 1))
    const to = new Date(Date.UTC(year, monthNumber, 1))
    if (from.getUTCFullYear() !== year || from.getUTCMonth() !== monthNumber - 1) throw new Error('month 不是有效月份')
    if (from > now) throw new Error('不能查询未来月份的账单')
    return { from, to: to > tomorrow ? tomorrow : to }
  }
  const from = query.from ? dateOnly(query.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = query.to ? dateOnly(query.to) : tomorrow
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error('账单时间范围无效')
  if (to > tomorrow || to - from > 32 * 86400000) throw new Error('账单查询最多支持 31 天且不能超过当前日期')
  return { from, to }
}

function errorText(error) {
  if (error.message === 'fetch failed') return `连接云厂商账单接口失败，请稍后重试${error.cause?.code ? `（${error.cause.code}）` : ''}`
  return error.response?.data?.message || error.response?.data?.error?.message || error.message || '账单查询失败'
}

export async function readAccountBilling(account, period, refresh = false) {
  const base = { accountId: account.id, accountName: account.name, provider: account.computeProvider }
  const identity = createHash('sha256').update(JSON.stringify(account)).digest('hex')
  const cacheKey = `${identity}:${period.from.toISOString()}:${period.to.toISOString()}`
  for (const [key, entry] of cache) if (Date.now() - entry.checkedAt >= CACHE_TTL_MS) cache.delete(key)
  const cached = cache.get(cacheKey)
  if (!refresh && cached) return cached.value
  if (pending.has(cacheKey)) return pending.get(cacheKey)
  const query = (async () => { try {
    const provider = getComputeProvider(account)
    if (typeof provider.getBilling !== 'function') throw new Error(`${account.computeProvider} 暂不支持账单查询`)
    const billing = await provider.getBilling({ from: period.from.toISOString(), to: period.to.toISOString() })
    const value = { ...base, ...billing, status: billing.status || 'ok' }
    if (value.status === 'ok') {
      if (cache.size >= 100) cache.delete(cache.keys().next().value)
      cache.set(cacheKey, { checkedAt: Date.now(), value })
    }
    return value
  } catch (error) {
    const value = { ...base, status: 'error', currency: 'USD', total: null, services: [], subscriptions: [], error: errorText(error), checkedAt: new Date().toISOString() }
    return value
  } })()
  pending.set(cacheKey, query)
  try { return await query } finally { pending.delete(cacheKey) }
}

router.get('/:accountId', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  let period
  try {
    period = getPeriod(req.query)
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }
  const account = accountsDb.data.accounts.find((item) => item.id === req.params.accountId && item.enabled !== false)
  if (!account) return res.status(404).json({ error: '启用的计算账户不存在' })
  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase())
  const value = await readAccountBilling(account, period, refresh)
  res.json({
    checkedAt: new Date().toISOString(),
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    account: value
  })
})

// 保留账户列表接口；这里不会查询任何账单，账单必须通过 /:accountId 单独加载。
router.get('/', (req, res) => {
  const accounts = accountsDb.data.accounts
    .filter((account) => account.enabled !== false)
    .map(({ id, name, computeProvider }) => ({ accountId: id, accountName: name, provider: computeProvider }))
  const value = {
    checkedAt: new Date().toISOString(),
    accounts
  }
  res.json(value)
})

export default router
