import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { EventEmitter, once } from 'node:events'
import express from 'express'
import AzureProvider from '../backend/providers/compute/AzureProvider.mjs'

const account = { id: 'azure-account', computeProvider: 'azure', name: 'Test', credentials: { tenant: 'test', appId: 'test', password: 'test' } }
const tasksDb = { data: { tasks: [] } }
const queueEmitter = new EventEmitter()
const createTask = mock.fn(async () => ({ id: 'test-task' }))
const prepareFreeCreate = mock.fn(async params => ({ ...params, location: 'region', vmSize: params.vmSize || 'Standard_B2pts_v2' }))
const bindPublicIp = mock.fn(async () => ({ ipAddress: '203.0.113.1' }))
const createPublicIp = mock.fn(async () => ({ name: 'created-ip', ipAddress: '203.0.113.2' }))
mock.module(new URL('../backend/db.mjs', import.meta.url).href, { namedExports: {
  accountsDb: { data: { accounts: [account] } }, dnsAccountsDb: { data: { dnsAccounts: [] } }, tasksDb
} })
mock.module(new URL('../backend/queue.mjs', import.meta.url).href, { namedExports: {
  createTask, queueEmitter, updateTask: async (id, updates) => Object.assign(tasksDb.data.tasks.find(t => t.id === id), updates)
} })
mock.module(new URL('../backend/providers/registry.mjs', import.meta.url).href, { namedExports: {
  getComputeProvider: () => {
    const p = new AzureProvider(account)
    p._ensureInitialized = async () => assert.fail('blocked request reached Azure')
    p.getInstance = async () => ({ displayName: 'Test VM' })
    p.prepareFreeCreate = (...args) => prepareFreeCreate(...args)
    p.bindPublicIp = (...args) => bindPublicIp(p.selectedSubscriptionId, ...args)
    p.createPublicIp = (...args) => createPublicIp(p.selectedSubscriptionId, ...args)
    return p
  },
  getDnsProvider: () => assert.fail('unexpected DNS call')
} })
mock.module(new URL('../backend/services/trafficUsage.mjs', import.meta.url).href, { namedExports: {
  getCurrentMonthPeriod: () => ({}), syncTrafficUsage: async () => ({})
} })
const { default: cloudRouter } = await import('../backend/routes/cloud.mjs')
await import('../backend/workers/cloudWorker.mjs')
const app = express()
app.use(express.json())
app.use('/api/cloud/:accountId', cloudRouter)
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const baseUrl = `http://127.0.0.1:${server.address().port}/api/cloud/azure-account`
after(async () => { queueEmitter.removeAllListeners(); await new Promise(resolve => server.close(resolve)) })

test('API rejects paid VM configurations but queues free sizes with an optional paid public IP', async () => {
  for (const params of [{ vmSize: 'Standard_D4s_v3' }, { imagePublisher: 'paid-marketplace' }, { storageAccountType: 'Standard_LRS' }]) {
    const response = await fetch(baseUrl + '/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, freeOnly: false, freeVerified: true }) })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'FreeOnlyMode')
  }
  assert.equal(createTask.mock.callCount(), 0)
  for (const vmSize of ['Standard_B1s', 'Standard_B2ats_v2', 'Standard_B2pts_v2']) {
    for (const createPublicIp of [false, true]) {
    const response = await fetch(baseUrl + '/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vmSize, createPublicIp, subscriptionId: 'sub', adminPassword: 'Test-only-password123!' }) })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).taskId, 'test-task')
    assert.equal(createTask.mock.calls.at(-1).arguments[2].createPublicIp, createPublicIp)
    }
  }
  assert.equal(createTask.mock.callCount(), 6)
  assert.equal(prepareFreeCreate.mock.callCount(), 6)
  const policy = await (await fetch(baseUrl + '/capabilities')).json()
  assert.equal(policy.costPolicy.creationAllowed, true)
  assert.equal(policy.costPolicy.startAllowed, true)
  assert.equal(policy.costPolicy.publicIpAllowed, true)
  assert.equal(policy.costPolicy.publicIp.chargeable, true)
  assert.equal(policy.costPolicy.publicIp.defaultEnabled, false)
})

test('create route queues server-selected defaults and rejects failed account benefit checks before queueing', async () => {
  const post = body => fetch(baseUrl + '/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriptionId: 'sub', adminPassword: 'Test-only-password123!', ...body }) })
  assert.equal((await post({})).status, 202)
  assert.equal(createTask.mock.calls.at(-1).arguments[2].vmSize, 'Standard_B2pts_v2')
  assert.equal(createTask.mock.calls.at(-1).arguments[2].location, 'region')
  const before = createTask.mock.callCount()
  prepareFreeCreate.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('免费权益已过期'), { code: 'FreeOnlyMode', statusCode: 403 }) })
  const response = await post({ freeVerified: true, freeOnly: false })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).code, 'FreeOnlyMode')
  assert.equal(createTask.mock.callCount(), before)
})

test('public IP binding route requires a subscription, passes the encoded instance ID and preserves conflict errors', async () => {
  const instanceId = '/subscriptions/sub/resourceGroups/group/providers/Microsoft.Compute/virtualMachines/vm'
  const url = baseUrl + '/instances/' + encodeURIComponent(instanceId) + '/public-ip'
  const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({ mode: 'new' })).status, 400)
  assert.equal(bindPublicIp.mock.callCount(), 0)
  const response = await post({ subscriptionId: 'sub', mode: 'existing', publicIpId: 'selected-ip' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ipAddress, '203.0.113.1')
  assert.deepEqual(bindPublicIp.mock.calls[0].arguments, ['sub', instanceId, { mode: 'existing', publicIpId: 'selected-ip' }])
  bindPublicIp.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('IP already used'), { statusCode: 409 }) })
  const failure = await post({ subscriptionId: 'sub', mode: 'new' })
  assert.equal(failure.status, 409)
  assert.equal((await failure.json()).error, 'IP already used')
})

test('standalone public IP creation route scopes the subscription and returns a created address', async () => {
  const post = body => fetch(baseUrl + '/public-ips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({ location: 'region', requestId: 'stable-standalone-request' })).status, 400)
  assert.equal(createPublicIp.mock.callCount(), 0)
  const response = await post({ subscriptionId: 'sub', location: 'region', requestId: 'stable-standalone-request' })
  assert.equal(response.status, 201)
  assert.equal((await response.json()).name, 'created-ip')
  assert.deepEqual(createPublicIp.mock.calls[0].arguments, ['sub', { location: 'region', requestId: 'stable-standalone-request' }])
  createPublicIp.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('invalid region'), { statusCode: 400 }) })
  assert.equal((await post({ subscriptionId: 'sub', location: 'bad' })).status, 400)
})

test('a restored paid Azure creation job fails once without retrying or provisioning', async () => {
  const task = { id: 'legacy', type: 'cloud:createInstance', accountId: account.id, status: 'pending', retries: 0,
    params: { subscriptionId: 'sub', vmSize: 'Standard_D4s_v3', delay: 1 } }
  tasksDb.data.tasks.push(task)
  queueEmitter.emit('task:new', task)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(task.status, 'failed')
  assert.equal(task.retries, 1)
  assert.match(task.error, /免费/)
})
