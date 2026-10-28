import { Router } from 'express'
import { accountsDb, dnsAccountsDb } from '../db.mjs'
import { getComputeProvider, getDnsProvider } from '../providers/registry.mjs'
import { createCloudInstance } from '../services/createCloudInstance.mjs'
import { getCurrentMonthPeriod, syncTrafficUsage } from '../services/trafficUsage.mjs'
import { generateInstancePassword } from '../utils/instancePassword.mjs'
import { AZURE_COST_POLICY } from '../utils/azureCostPolicy.mjs'

const router = Router({ mergeParams: true })
const READ_TIMEOUT_MS = Number(process.env.CLOUD_READ_TIMEOUT_MS || 8000)
const TRAFFIC_TIMEOUT_MS = Number(process.env.CLOUD_TRAFFIC_TIMEOUT_MS || 30000)

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

function setSwitchIpLog(req, target) {
  setOperationLogTarget(req, target)
}

function markSwitchIpFailure(req, account, instanceId, phase, error) {
  const message = error?.message || String(error || '未知错误')
  const label = phase === 'dns' ? '域名更新失败' : '服务器 IP 切换失败'

  setSwitchIpLog(req, {
    switchIpPhase: phase,
    switchIpStatus: 'failed',
    switchIpError: message,
    ...(phase === 'dns'
      ? { dnsUpdateStatus: 'failed', dnsUpdateError: message }
      : { serverSwitchStatus: 'failed', serverSwitchError: message })
  })

  console.error(
    `[switch-ip] ${label}: account=${account.id} instance=${instanceId} ` +
    `phase=${phase} error=${message}`
  )

  return `${label}: ${message}`
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
    res.json({ provider: account.computeProvider, capabilities: provider.constructor.capabilities || [],
      ...(account.computeProvider === 'azure' ? { costPolicy: AZURE_COST_POLICY } : {}) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/traffic-usage', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    const period = getCurrentMonthPeriod()
    const result = await withTimeout(
      syncTrafficUsage(account, provider, period),
      TRAFFIC_TIMEOUT_MS,
      `${account.computeProvider} 云流量统计请求超时（>${TRAFFIC_TIMEOUT_MS}ms）`
    )
    res.json(result)
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

router.get('/azure/subscription-billing', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const account = requireAccount(req.params.accountId)
    if (account.computeProvider !== 'azure') return res.status(400).json({ error: '当前账户不是 Azure 账户' })
    if (typeof req.query.subscriptionId !== 'string' || !req.query.subscriptionId.trim()) {
      return res.status(400).json({ error: 'subscriptionId 为必填项' })
    }
    res.json(await getComputeProvider(account).getSubscriptionBilling(req.query.subscriptionId.trim()))
  } catch (error) {
    res.status(error.statusCode === 400 ? 400 : 500).json({ error: error.message })
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

router.get('/azure/create-options', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const account = requireAccount(req.params.accountId)
    if (account.computeProvider !== 'azure') return res.status(400).json({ error: '当前账户不是 Azure 账户' })
    if (typeof req.query.subscriptionId !== 'string' || !req.query.subscriptionId.trim()) {
      return res.status(400).json({ error: 'subscriptionId 为必填项' })
    }
    res.json(await getComputeProvider(account).listCreateOptions(req.query.subscriptionId.trim()))
  } catch (error) {
    res.status([400, 403].includes(error.statusCode) ? error.statusCode : 500).json({ error: error.message, code: error.code })
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
    res.status([400, 403].includes(err.statusCode) ? err.statusCode : 500).json({ error: err.message, code: err.code })
  }
})

router.get('/instance-password', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const account = requireAccount(req.params.accountId)
    if (!['oracle', 'aws', 'azure'].includes(account.computeProvider)) {
      return res.status(400).json({ error: '该平台暂不支持生成实例密码' })
    }
    res.json({ password: generateInstancePassword() })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

router.post('/instances', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    res.status(202).json(await createCloudInstance(account, req.body))
  } catch (err) {
    res.status([400, 403].includes(err.statusCode) ? err.statusCode : 500).json({ error: err.message, code: err.code })
  }
})

router.post('/instances/:instanceId/action', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    const { action = 'START' } = req.body
    res.json({ success: true, ...(await provider.instanceAction(req.params.instanceId, action)) })
  } catch (err) {
    res.status(err.statusCode === 403 ? 403 : 500).json({ error: err.message, code: err.code })
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

router.post('/instances/:instanceId/public-ip', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    if (!(provider.constructor.capabilities || []).includes('bind_public_ip')) {
      return res.status(400).json({ error: '当前账户不支持绑定公网 IP' })
    }
    if (typeof req.body?.subscriptionId !== 'string' || !req.body.subscriptionId.trim()) {
      return res.status(400).json({ error: '请选择 Azure 订阅' })
    }
    setOperationLogTarget(req, { accountName: account.name })
    await attachInstanceOperationLogTarget(req, account, provider)
    const { mode, publicIpId } = req.body
    res.json({ success: true, ...(await provider.bindPublicIp(req.params.instanceId, { mode, publicIpId })) })
  } catch (error) {
    res.status([400, 403, 404, 409, 412].includes(error.statusCode) ? error.statusCode : 500)
      .json({ error: error.message, publicIpId: error.publicIpId })
  }
})

router.post('/instances/:instanceId/switch-ip', async (req, res) => {
  let account = null
  let phase = 'server'

  try {
    account = requireAccount(req.params.accountId)
    setOperationLogTarget(req, { accountName: account.name })
    const provider = getScopedProvider(account, req)
    await attachInstanceOperationLogTarget(req, account, provider)

    const providerCapabilities = provider.constructor.capabilities || []
    const body = req.body || {}

    const ipTypes = normalizeIpTypes(body.ipTypes ?? body.ipType ?? body.type)
    const hasDnsUpdate = Boolean(body.dnsAccountId && body.dnsRecord)
    setSwitchIpLog(req, {
      switchIpPhase: 'server',
      switchIpStatus: 'running',
      switchIpTypes: ipTypes,
      serverSwitchStatus: 'running',
      dnsUpdateStatus: hasDnsUpdate ? 'pending' : 'not_requested'
    })

    console.info(
      `[switch-ip] start: account=${account.id} instance=${req.params.instanceId} ` +
      `types=${ipTypes.join(',')} dns=${hasDnsUpdate ? 'enabled' : 'disabled'}`
    )

    if (ipTypes.includes('ipv4') && !providerCapabilities.includes('switch_ip') && !providerCapabilities.includes('elastic_ip')) {
      const error = new Error(`${account.computeProvider} 不支持切换 IP`)
      const message = markSwitchIpFailure(req, account, req.params.instanceId, 'server', error)
      return res.status(400).json({ error: message, stage: 'server' })
    }
    if (ipTypes.includes('ipv6') && !providerCapabilities.includes('switch_ipv6')) {
      const error = new Error(`${account.computeProvider} 不支持切换 IPv6`)
      const message = markSwitchIpFailure(req, account, req.params.instanceId, 'server', error)
      return res.status(400).json({ error: message, stage: 'server' })
    }

    const result = await provider.switchPublicIp(req.params.instanceId, { ipTypes })
    setSwitchIpLog(req, {
      serverSwitchStatus: 'success',
      serverSwitchResult: {
        newIpv4: result.newIpv4 || '',
        newIpv6: result.newIpv6 || '',
        newIp: result.newIp || result.newPublicIp || ''
      }
    })
    console.info(
      `[switch-ip] server switch succeeded: account=${account.id} instance=${req.params.instanceId} ` +
      `ipv4=${result.newIpv4 || result.newIp || result.newPublicIp || '-'} ipv6=${result.newIpv6 || '-'}`
    )

    const { dnsAccountId, dnsRecord } = body
    const dnsUpdates = []

    if (dnsAccountId && dnsRecord) {
      phase = 'dns'
      setSwitchIpLog(req, {
        switchIpPhase: 'dns',
        dnsAccountId,
        dnsRecord,
        dnsUpdateStatus: 'running',
        dnsUpdateResults: []
      })

      const dnsAccount = dnsAccountsDb.data.dnsAccounts.find((item) => item.id === dnsAccountId)
      if (!dnsAccount) {
        throw Object.assign(new Error(`找不到 DNS 账户: ${dnsAccountId}`), { switchIpStage: 'dns' })
      }

      const dnsProvider = getDnsProvider(dnsAccount)
      const dnsUpdateResults = []
      const updateRecord = async (recordType, address) => {
        try {
          const update = await dnsProvider.upsertRecord(dnsRecord, address, recordType)
          dnsUpdates.push(update)
          dnsUpdateResults.push({ type: recordType, status: 'success', address })
          setSwitchIpLog(req, { dnsUpdateResults: dnsUpdateResults.slice() })
        } catch (error) {
          dnsUpdateResults.push({ type: recordType, status: 'failed', address, error: error.message })
          setSwitchIpLog(req, {
            dnsUpdateResults: dnsUpdateResults.slice(),
            dnsUpdateStatus: 'failed',
            dnsUpdateError: error.message
          })
          throw Object.assign(error, { switchIpStage: 'dns' })
        }
      }

      if (ipTypes.includes('ipv4') && result.newIpv4) await updateRecord('A', result.newIpv4)
      if (ipTypes.includes('ipv6') && result.newIpv6) await updateRecord('AAAA', result.newIpv6)

      setSwitchIpLog(req, {
        dnsUpdateStatus: 'success',
        switchIpPhase: 'complete',
        switchIpStatus: 'success',
        dnsUpdateResults
      })
      console.info(
        `[switch-ip] DNS update succeeded: account=${account.id} instance=${req.params.instanceId} ` +
        `record=${dnsRecord} updates=${dnsUpdateResults.length}`
      )
    } else {
      setSwitchIpLog(req, { switchIpPhase: 'complete', switchIpStatus: 'success' })
    }

    res.json({ success: true, ...result, dnsUpdates })
  } catch (err) {
    if (!account) return res.status(500).json({ error: err.message })
    const message = markSwitchIpFailure(req, account, req.params.instanceId, err.switchIpStage || phase, err)
    res.status(500).json({ error: message, stage: err.switchIpStage || phase })
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

router.get('/public-ips', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    if (!(provider.constructor.capabilities || []).includes('manage_public_ips')) {
      return res.status(400).json({ error: '当前账户不支持管理公网 IP' })
    }
    res.json(await withTimeout(provider.listPublicIps(), TRAFFIC_TIMEOUT_MS, '公网 IP 列表请求超时，请重试'))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/public-ips', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    if (typeof req.body?.subscriptionId !== 'string' || !req.body.subscriptionId.trim()) {
      return res.status(400).json({ error: '请选择 Azure 订阅' })
    }
    const provider = getScopedProvider(account, req)
    if (!(provider.constructor.capabilities || []).includes('manage_public_ips') || typeof provider.createPublicIp !== 'function') {
      return res.status(400).json({ error: '当前账户不支持创建公网 IP' })
    }
    setOperationLogTarget(req, { accountName: account.name, targetName: '新建公网 IP' })
    const { location, requestId } = req.body
    const result = await provider.createPublicIp({ location, requestId })
    setOperationLogTarget(req, { targetName: result.name, publicIpAddress: result.ipAddress })
    res.status(201).json(result)
  } catch (error) {
    res.status([400, 403, 404, 409].includes(error.statusCode) ? error.statusCode : 500)
      .json({ error: error.message, code: error.code })
  }
})

router.post('/public-ips/:publicIpId/detach-and-delete', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    setOperationLogTarget(req, { accountName: account.name, targetName: req.params.publicIpId.split('/').at(-1) })
    if (!(provider.constructor.capabilities || []).includes('manage_public_ips')) {
      return res.status(400).json({ error: '当前账户不支持管理公网 IP' })
    }
    const result = await provider.deletePublicIp(req.params.publicIpId, { detachUnusedNic: true })
    setOperationLogTarget(req, { targetName: result.name, publicIpAddress: result.ipAddress, detachedNicId: result.detachedNicId })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status([400, 403, 404, 409, 412].includes(err.statusCode) ? err.statusCode : 500).json({ error: err.message })
  }
})

router.delete('/public-ips/:publicIpId', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    setOperationLogTarget(req, { accountName: account.name, targetName: req.params.publicIpId.split('/').at(-1) })
    if (!(provider.constructor.capabilities || []).includes('manage_public_ips')) {
      return res.status(400).json({ error: '当前账户不支持管理公网 IP' })
    }
    const result = await provider.deletePublicIp(req.params.publicIpId)
    setOperationLogTarget(req, { targetName: result.name, publicIpAddress: result.ipAddress })
    res.json({ success: true, ...result })
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.statusCode) ? err.statusCode : 500).json({ error: err.message })
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

router.put('/instances/:instanceId/name', async (req, res) => {
  try {
    const account = requireAccount(req.params.accountId)
    const provider = getScopedProvider(account, req)
    if (!(provider.constructor.capabilities || []).includes('rename_instance')) {
      return res.status(400).json({ error: `${account.computeProvider} 不支持修改实例名称` })
    }

    const name = req.body?.displayName
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
      return res.status(400).json({ error: '实例名称须为 1–255 个字符，且不能包含换行或控制字符' })
    }

    await attachInstanceOperationLogTarget(req, account, provider)
    const result = await provider.renameInstance(req.params.instanceId, name.trim())
    setOperationLogTarget(req, { newInstanceName: result.displayName })
    res.json({ success: true, ...result })
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
