import { Router } from 'express'
import { accountsDb, dnsAccountsDb } from '../db.mjs'
import { getComputeProvider, getDnsProvider } from '../providers/registry.mjs'
import { createTask } from '../queue.mjs'
import { validateOracleInstancePassword } from '../utils/oraclePassword.mjs'

const router = Router({ mergeParams: true })
const READ_TIMEOUT_MS = Number(process.env.CLOUD_READ_TIMEOUT_MS || 8000)

function requireAccount(id) {
  const account = accountsDb.data.accounts.find((item) => item.id === id && item.enabled !== false)
  if (!account) {
    throw new Error(`计算账户不存在: ${id}`)
  }
  return account
}

function resolveAzureSubscriptionId(req) {
  return req.body?.subscriptionId || req.query?.subscriptionId || ''
}

function getScopedProvider(account, req) {
  const provider = getComputeProvider(account)
  if (account.computeProvider === 'azure' && typeof provider.useSubscription === 'function') {
    provider.useSubscription(resolveAzureSubscriptionId(req))
  }
  return provider
}

function setOperationLogTarget(req, target) {
  req.operationLogTarget = {
    ...(req.operationLogTarget || {}),
    ...target
  }
}

function getInstanceDisplayName(instance) {
  return instance?.displayName || instance?.name || ''
}

async function attachInstanceOperationLogTarget(req, account, provider) {
  setOperationLogTarget(req, { accountName: account.name })

  if (!req.params.instanceId || req.operationLogTarget.instanceName) return

  try {
    const instance = await withTimeout(
      provider.getInstance(req.params.instanceId),
      READ_TIMEOUT_MS,
      `${account.computeProvider} 实例详情请求超时（>${READ_TIMEOUT_MS}ms）`
    )
    const instanceName = getInstanceDisplayName(instance)
    if (instanceName) {
      setOperationLogTarget(req, { instanceName })
    }
  } catch (_) {
  }
}

function normalizeIpTypes(value) {
  let items = []

  if (Array.isArray(value)) {
    items = value
  } else if (typeof value === 'string') {
    items = value.split(',')
  } else if (value && typeof value === 'object') {
    if (value.ipv4) items.push('ipv4')
    if (value.ipv6) items.push('ipv6')
  }

  const normalized = items
    .map((item) => String(item || '').trim().toLowerCase())
    .flatMap((item) => (['all', 'both'].includes(item) ? ['ipv4', 'ipv6'] : [item]))
    .filter((item) => ['ipv4', 'ipv6'].includes(item))

  return Array.from(new Set(normalized.length ? normalized : ['ipv4']))
}

function withTimeout(promise, ms, message) {
  let timer = null

  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ])
}

router.get('/instances', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    const result = await withTimeout(
      provider.listInstances(),
      READ_TIMEOUT_MS,
      `${account.computeProvider} 实例列表请求超时（>${READ_TIMEOUT_MS}ms）`
    )
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/instances/:instanceId', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    const result = await withTimeout(
      provider.getInstance(req.params.instanceId),
      READ_TIMEOUT_MS,
      `${account.computeProvider} 实例详情请求超时（>${READ_TIMEOUT_MS}ms）`
    )
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/capabilities', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    res.json({ provider: account.computeProvider, capabilities: provider.constructor.capabilities || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/azure/subscriptions', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    if (account.computeProvider !== 'azure') {
      return res.status(400).json({ error: '当前账户不是 Azure 账户' })
    }

    const provider = getComputeProvider(account)
    res.json(await provider.listEligibleSubscriptions())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/azure/locations', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    if (account.computeProvider !== 'azure') {
      return res.status(400).json({ error: '当前账户不是 Azure 账户' })
    }

    const provider = getComputeProvider(account)
    res.json(await provider.listLocations(req.query.subscriptionId))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/azure/vm-sizes', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    if (account.computeProvider !== 'azure') {
      return res.status(400).json({ error: '当前账户不是 Azure 账户' })
    }
    if (!req.query.location) {
      return res.status(400).json({ error: 'location 为必填项' })
    }

    const provider = getComputeProvider(account)
    res.json(await provider.listVmSizes(req.query.location, req.query.subscriptionId))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/instances', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const { delay = 60, ...params } = req.body

    if (account.computeProvider === 'oracle') {
      validateOracleInstancePassword(params.rootPassword)
    }
    if (account.computeProvider === 'azure' && !params.adminPassword) {
      throw new Error('Azure 实例创建需要 adminPassword')
    }

    const task = await createTask('cloud:createInstance', account.id, {
      ...params,
      delay,
      provider: account.computeProvider
    })

    res.status(202).json({ taskId: task.id, message: '创建任务已加入队列' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/instances/:instanceId/action', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    const { action = 'START' } = req.body
    res.json({ success: true, ...(await provider.instanceAction(req.params.instanceId, action)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/instances/:instanceId', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    res.json({ success: true, ...(await provider.deleteInstance(req.params.instanceId)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/instances/:instanceId/switch-ip', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    await attachInstanceOperationLogTarget(req, account, provider)

    const providerCapabilities = provider.constructor.capabilities || []
    const body = req.body || {}

    const ipTypes = normalizeIpTypes(body.ipTypes ?? body.ipType ?? body.type)

    if (ipTypes.includes('ipv4') && !providerCapabilities.includes('switch_ip') && !providerCapabilities.includes('elastic_ip')) {
      return res.status(400).json({ error: `${account.computeProvider} 不支持切换 IP` })
    }
    if (ipTypes.includes('ipv6') && !providerCapabilities.includes('switch_ipv6')) {
      return res.status(400).json({ error: `${account.computeProvider} 不支持切换 IPv6` })
    }

    const result = await provider.switchPublicIp(req.params.instanceId, { ipTypes })
    const { dnsAccountId, dnsRecord } = body
    const dnsUpdates = []

    if (dnsAccountId && dnsRecord) {
      const dnsAccount = dnsAccountsDb.data.dnsAccounts.find((item) => item.id === dnsAccountId)
      if (dnsAccount) {
        const dnsProvider = getDnsProvider(dnsAccount)
        if (ipTypes.includes('ipv4') && result.newIpv4) {
          dnsUpdates.push(await dnsProvider.upsertRecord(dnsRecord, result.newIpv4, 'A'))
        }
        if (ipTypes.includes('ipv6') && result.newIpv6) {
          dnsUpdates.push(await dnsProvider.upsertRecord(dnsRecord, result.newIpv6, 'AAAA'))
        }
      }
    }

    res.json({ success: true, ...result, dnsUpdates })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/instances/:instanceId/add-ipv6', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)

    if (!(provider.constructor.capabilities || []).includes('ipv6')) {
      return res.status(400).json({ error: `${account.computeProvider} 不支持 IPv6` })
    }

    res.json({ success: true, ...(await provider.addIpv6(req.params.instanceId)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/elastic-ips', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)

    if (typeof provider.listElasticIps !== 'function') {
      return res.status(400).json({ error: '当前云账户不支持弹性 IP 查询' })
    }

    const result = await withTimeout(
      provider.listElasticIps(),
      READ_TIMEOUT_MS,
      `${account.computeProvider} 弹性 IP 列表请求超时（>${READ_TIMEOUT_MS}ms）`
    )
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/elastic-ips/release-unused', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)

    if (typeof provider.releaseUnusedElasticIps !== 'function') {
      return res.status(400).json({ error: '当前云账户不支持释放空闲弹性 IP' })
    }

    const results = await provider.releaseUnusedElasticIps()
    res.json({ released: results.filter((item) => item.success).length, results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/instances/:instanceId/shape', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)

    if (!(provider.constructor.capabilities || []).includes('modify_config')) {
      return res.status(400).json({ error: `${account.computeProvider} 不支持修改配置` })
    }

    res.json({ success: true, ...(await provider.modifyInstanceConfig(req.params.instanceId, req.body)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/instances/:instanceId/firewall/allow-all', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    res.json({ success: true, ...(await provider.allowAllInboundTraffic(req.params.instanceId)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/volumes', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)

    if (!(provider.constructor.capabilities || []).includes('list_boot_volumes')) {
      return res.status(400).json({ error: `${account.computeProvider} 不支持管理引导卷` })
    }

    const result = await withTimeout(
      provider.listBootVolumes(),
      READ_TIMEOUT_MS,
      `${account.computeProvider} 卷列表请求超时（>${READ_TIMEOUT_MS}ms）`
    )
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/volumes/:volumeId', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    res.json({ success: true, ...(await provider.deleteBootVolume(req.params.volumeId)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/volumes/:volumeId/size', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)

    if (!(provider.constructor.capabilities || []).includes('resize_boot_volume')) {
      return res.status(400).json({ error: `${account.computeProvider} 不支持修改引导卷大小` })
    }

    res.json({ success: true, ...(await provider.resizeBootVolume(req.params.volumeId, req.body.sizeInGBs)) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/network/setup', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)

    if (typeof provider.createNetwork !== 'function') {
      return res.status(400).json({ error: `${account.computeProvider} 不支持自动创建网络` })
    }

    res.json({ success: true, ...(await provider.createNetwork()) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
