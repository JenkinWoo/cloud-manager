import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { EventEmitter, once } from 'node:events'
import express from 'express'
import AzureProvider from '../backend/providers/compute/AzureProvider.mjs'

const account = { id: 'azure-account', computeProvider: 'azure', name: 'Test', credentials: { tenant: 'test', appId: 'test', password: 'test' } }
const tasksDb = { data: { tasks: [] } }
const queueEmitter = new EventEmitter()
const createTask = mock.fn(async () => ({ id: 'test-task' }))
mock.module(new URL('../backend/db.mjs', import.meta.url).href, { namedExports: {
  accountsDb: { data: { accounts: [account] } }, dnsAccountsDb: { data: { dnsAccounts: [] } }, tasksDb
} })
mock.module(new URL('../backend/queue.mjs', import.meta.url).href, { namedExports: {
  createTask, queueEmitter, updateTask: async (id, updates) => Object.assign(tasksDb.data.tasks.find(t => t.id === id), updates)
} })
mock.module(new URL('../backend/providers/registry.mjs', import.meta.url).href, { namedExports: {
  getComputeProvider: () => { const p = new AzureProvider(account); p._ensureInitialized = async () => assert.fail('blocked request reached Azure'); return p },
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

test('API rejects paid configurations before queuing but accepts all free VM sizes', async () => {
  for (const params of [{ vmSize: 'Standard_D4s_v3' }, { createPublicIp: true }, { storageAccountType: 'Standard_LRS' }]) {
    const response = await fetch(baseUrl + '/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, freeOnly: false, freeVerified: true }) })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'FreeOnlyMode')
  }
  assert.equal(createTask.mock.callCount(), 0)
  for (const vmSize of ['Standard_B1s', 'Standard_B2ats_v2', 'Standard_B2pts_v2']) {
    const response = await fetch(baseUrl + '/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vmSize, subscriptionId: 'sub', adminPassword: 'Test-only-password123!' }) })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).taskId, 'test-task')
  }
  assert.equal(createTask.mock.callCount(), 3)
  const policy = await (await fetch(baseUrl + '/capabilities')).json()
  assert.equal(policy.costPolicy.creationAllowed, true)
  assert.equal(policy.costPolicy.startAllowed, true)
  assert.equal(policy.costPolicy.publicIpAllowed, false)
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
