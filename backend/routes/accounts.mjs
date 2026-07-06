import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { accountsDb, dnsAccountsDb } from '../db.mjs'
import { listProviders } from '../providers/registry.mjs'
import { getComputeProvider } from '../providers/registry.mjs'
import { normalizeAzureCredentials } from '../utils/azureCredentials.mjs'

const router = Router()
const ORACLE_ACCOUNT_TYPE_CACHE_VERSION = 6
const ORACLE_ACCOUNT_TYPE_LABELS = {
  free: '免费账户',
  upgraded: '升级账户',
  unknown: '未知'
}

function shouldIncludeDisabled(req) {
  return ['1', 'true', 'yes'].includes(String(req.query.includeDisabled || '').toLowerCase())
}

function shouldRefresh(req) {
  return ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase())
}

function filterEnabled(items, includeDisabled) {
  return includeDisabled ? items : items.filter((item) => item.enabled !== false)
}

function hasCachedOracleAccountType(account) {
  return (
    ['upgraded', 'free', 'unknown'].includes(account?.oracleAccountType?.type) &&
    account.oracleAccountType.cacheVersion === ORACLE_ACCOUNT_TYPE_CACHE_VERSION
  )
}

function normalizeOracleAccountTypeMode(value) {
  return ['auto', 'free', 'upgraded'].includes(value) ? value : 'auto'
}

function manualOracleAccountType(account) {
  const mode = normalizeOracleAccountTypeMode(account?.oracleAccountTypeMode)
  if (!['free', 'upgraded'].includes(mode)) return null

  return {
    type: mode,
    label: ORACLE_ACCOUNT_TYPE_LABELS[mode],
    reason: '账户管理中手动设置',
    source: 'manual',
    checkedAt: new Date().toISOString()
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function buildOracleAccountType(accountType) {
  return {
    type: accountType?.type || 'unknown',
    label: accountType?.label || ORACLE_ACCOUNT_TYPE_LABELS[accountType?.type] || '未知',
    reason: accountType?.reason || '',
    source: accountType?.source || '',
    cacheVersion: ORACLE_ACCOUNT_TYPE_CACHE_VERSION,
    checkedAt: accountType?.checkedAt || new Date().toISOString(),
    homeRegionId: accountType?.homeRegionId || '',
    subscriptionCount: accountType?.subscriptionCount || 0,
    subscriptionIds: Array.isArray(accountType?.subscriptionIds) ? accountType.subscriptionIds : [],
    serviceNames: Array.isArray(accountType?.serviceNames) ? accountType.serviceNames : [],
    checkedLimits: Array.isArray(accountType?.checkedLimits) ? accountType.checkedLimits : []
  }
}

async function saveOracleAccountType(account, accountType) {
  account.oracleAccountType = buildOracleAccountType(accountType)
  await accountsDb.write()
  return account.oracleAccountType
}

function reorderItemsByIds(items, ids) {
  if (!Array.isArray(ids) || ids.length !== items.length) {
    throw new Error('排序列表不完整')
  }

  const itemMap = new Map(items.map((item) => [item.id, item]))
  const uniqueIds = new Set(ids)
  if (uniqueIds.size !== ids.length || ids.some((id) => !itemMap.has(id))) {
    throw new Error('排序列表包含无效账户')
  }

  return ids.map((id) => itemMap.get(id))
}

// ─── 计算账户 ──────────────────────────────────────────────

// GET /api/accounts - 列出所有账户
router.get('/', (req, res) => {
  res.json(filterEnabled(accountsDb.data.accounts, shouldIncludeDisabled(req)))
})

// GET /api/accounts/providers - 列出支持的 Provider
router.get('/providers', (req, res) => {
  res.json(listProviders())
})

// POST /api/accounts - 新建账户
router.post('/', async (req, res) => {
  try {
    const { name, computeProvider, credentials = {}, enabled = true, oracleAccountTypeMode = 'auto' } = req.body
    if (!name || !computeProvider) return res.status(400).json({ error: 'name 和 computeProvider 为必填项' })

    const normalizedCredentials = computeProvider === 'azure' ? normalizeAzureCredentials(credentials) : credentials

    const account = {
      id: uuidv4(),
      name, computeProvider, credentials: normalizedCredentials, enabled,
      createdAt: new Date().toISOString()
    }
    if (computeProvider === 'oracle') {
      account.oracleAccountTypeMode = normalizeOracleAccountTypeMode(oracleAccountTypeMode)
      const manualType = manualOracleAccountType(account)
      if (manualType) account.oracleAccountType = buildOracleAccountType(manualType)
    }
    accountsDb.data.accounts.push(account)
    await accountsDb.write()
    res.status(201).json(account)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/accounts/reorder
router.put('/reorder', async (req, res) => {
  try {
    accountsDb.data.accounts = reorderItemsByIds(accountsDb.data.accounts, req.body?.ids)
    await accountsDb.write()
    res.json(accountsDb.data.accounts)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// PUT /api/accounts/:id
router.put('/:id', async (req, res) => {
  try {
    const account = accountsDb.data.accounts.find(a => a.id === req.params.id)
    if (!account) return res.status(404).json({ error: '账户不存在' })
    const nextPayload = { ...req.body }
    const nextComputeProvider = nextPayload.computeProvider || account.computeProvider
    if (nextComputeProvider === 'oracle' && Object.hasOwn(nextPayload, 'oracleAccountTypeMode')) {
      nextPayload.oracleAccountTypeMode = normalizeOracleAccountTypeMode(nextPayload.oracleAccountTypeMode)
    }
    if ((nextPayload.computeProvider || account.computeProvider) === 'azure') {
      nextPayload.credentials = normalizeAzureCredentials(nextPayload.credentials || account.credentials || {})
    }
    if (
      nextComputeProvider === 'oracle' &&
      Object.hasOwn(nextPayload, 'credentials') &&
      stableStringify(nextPayload.credentials || {}) !== stableStringify(account.credentials || {})
    ) {
      delete account.oracleAccountType
    }
    Object.assign(account, nextPayload, { id: account.id, createdAt: account.createdAt })
    if (account.computeProvider !== 'oracle') {
      delete account.oracleAccountType
      delete account.oracleAccountTypeMode
    } else {
      account.oracleAccountTypeMode = normalizeOracleAccountTypeMode(account.oracleAccountTypeMode)
      const manualType = manualOracleAccountType(account)
      if (manualType) account.oracleAccountType = buildOracleAccountType(manualType)
      else if (account.oracleAccountType?.source === 'manual') delete account.oracleAccountType
    }
    await accountsDb.write()
    res.json(account)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/accounts/:id
router.delete('/:id', async (req, res) => {
  try {
    const idx = accountsDb.data.accounts.findIndex(a => a.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: '账户不存在' })
    accountsDb.data.accounts.splice(idx, 1)
    await accountsDb.write()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/accounts/:id/test
router.post('/:id/test', async (req, res) => {
  try {
    const account = accountsDb.data.accounts.find(a => a.id === req.params.id)
    if (!account) return res.status(404).json({ error: '账户不存在' })
    const provider = getComputeProvider(account)
    await provider.listInstances() // quick test
    let oracleAccountType = null
    if (account.computeProvider === 'oracle') {
      oracleAccountType = manualOracleAccountType(account)
        ? await saveOracleAccountType(account, manualOracleAccountType(account))
        : typeof provider.getAccountType === 'function'
          ? await saveOracleAccountType(account, await provider.getAccountType())
          : null
    }
    res.json({ success: true, message: `${account.computeProvider} 连接成功`, oracleAccountType })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/accounts/:id/oracle-account-type
router.get('/:id/oracle-account-type', async (req, res) => {
  const account = accountsDb.data.accounts.find(a => a.id === req.params.id)
  if (!account) return res.status(404).json({ error: '账户不存在' })
  if (account.computeProvider !== 'oracle') return res.status(400).json({ error: '仅 Oracle 账户支持账户类型检测' })
  const manualType = manualOracleAccountType(account)
  if (manualType) {
    const accountType = await saveOracleAccountType(account, manualType)
    return res.json({ ...accountType, cached: true })
  }
  if (hasCachedOracleAccountType(account) && !shouldRefresh(req)) {
    return res.json({ ...account.oracleAccountType, cached: true })
  }

  try {
    const provider = getComputeProvider(account)
    if (typeof provider.getAccountType !== 'function') {
      const accountType = await saveOracleAccountType(account, {
        type: 'unknown',
        label: '未知',
        reason: '当前 Provider 未实现账户类型检测',
        checkedAt: new Date().toISOString()
      })
      return res.json({ ...accountType, cached: false })
    }
    const accountType = await saveOracleAccountType(account, await provider.getAccountType())
    res.json({ ...accountType, cached: false })
  } catch (err) {
    const accountType = await saveOracleAccountType(account, {
      type: 'unknown',
      label: '未知',
      reason: err.message,
      checkedAt: new Date().toISOString()
    })
    res.json({ ...accountType, cached: false })
  }
})

// ─── DNS 账户 ──────────────────────────────────────────────

// GET /api/accounts/dns
router.get('/dns', (req, res) => {
  res.json(filterEnabled(dnsAccountsDb.data.dnsAccounts, shouldIncludeDisabled(req)))
})

// POST /api/accounts/dns
router.post('/dns', async (req, res) => {
  try {
    const { name, dnsProvider, credentials = {}, enabled = true } = req.body
    if (!name || !dnsProvider) return res.status(400).json({ error: 'name 和 dnsProvider 为必填项' })

    const dnsAccount = {
      id: uuidv4(),
      name, dnsProvider, credentials, enabled,
      createdAt: new Date().toISOString()
    }
    dnsAccountsDb.data.dnsAccounts.push(dnsAccount)
    await dnsAccountsDb.write()
    res.status(201).json(dnsAccount)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/accounts/dns/reorder
router.put('/dns/reorder', async (req, res) => {
  try {
    dnsAccountsDb.data.dnsAccounts = reorderItemsByIds(dnsAccountsDb.data.dnsAccounts, req.body?.ids)
    await dnsAccountsDb.write()
    res.json(dnsAccountsDb.data.dnsAccounts)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// PUT /api/accounts/dns/:id
router.put('/dns/:id', async (req, res) => {
  try {
    const a = dnsAccountsDb.data.dnsAccounts.find(x => x.id === req.params.id)
    if (!a) return res.status(404).json({ error: 'DNS 账户不存在' })
    Object.assign(a, req.body, { id: a.id, createdAt: a.createdAt })
    await dnsAccountsDb.write()
    res.json(a)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/accounts/dns/:id
router.delete('/dns/:id', async (req, res) => {
  try {
    const idx = dnsAccountsDb.data.dnsAccounts.findIndex(x => x.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: 'DNS 账户不存在' })
    dnsAccountsDb.data.dnsAccounts.splice(idx, 1)
    await dnsAccountsDb.write()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/accounts/dns/:id/test
router.post('/dns/:id/test', async (req, res) => {
  try {
    const a = dnsAccountsDb.data.dnsAccounts.find(x => x.id === req.params.id)
    if (!a) return res.status(404).json({ error: 'DNS 账户不存在' })
    const { getDnsProvider } = await import('../providers/registry.mjs')
    const provider = getDnsProvider(a)
    await provider.listRecords()
    res.json({ success: true, message: `${a.dnsProvider} 连接成功` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
