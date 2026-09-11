import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { once } from 'node:events'
import express from 'express'

const memoryStore = (data) => ({ data, write: mock.fn(async () => {}) })
const tasksDb = memoryStore({ tasks: [] })
const operationLogsDb = memoryStore({ logs: [] })
const settingsDb = memoryStore({ operationLogs: { retentionDays: 30 }, auth: {
  username: 'test-user', passwordHash: 'test-only-hash', passwordSalt: 'test-only-salt', sessions: [{ token: 'test-session' }]
} })
const accountsDb = memoryStore({ accounts: ['oracle', 'azure', 'aws'].map((provider) => ({
  id: `${provider}-account`, name: `${provider} test`, computeProvider: provider
})) })
mock.module(new URL('../backend/db.mjs', import.meta.url).href, { namedExports: {
  accountsDb, tasksDb, operationLogsDb, settingsDb, dnsAccountsDb: memoryStore({ dnsAccounts: [] })
} })
let provision
mock.module(new URL('../backend/providers/registry.mjs', import.meta.url).href, { namedExports: {
  getComputeProvider: () => ({ createInstance: (params) => provision(params) }),
  getDnsProvider: () => { throw new Error('DNS should not be used') }
} })
mock.module(new URL('../backend/services/trafficUsage.mjs', import.meta.url).href, { namedExports: {
  getCurrentMonthPeriod: () => ({}), syncTrafficUsage: async () => ({})
} })
const { default: cloudRouter } = await import('../backend/routes/cloud.mjs')
const { default: tasksRouter } = await import('../backend/routes/tasks.mjs')
const { authRequired } = await import('../backend/routes/auth.mjs')
const { operationLogMiddleware } = await import('../backend/utils/operationLog.mjs')
const { createTask, updateTask, getTask, getTasks, sseClients, queueEmitter } = await import('../backend/queue.mjs')

let server
let baseUrl
before(async () => {
  const app = express()
  app.use(express.json(), operationLogMiddleware)
  app.use('/api', authRequired)
  app.use('/api/cloud/:accountId', cloudRouter)
  app.use('/api/tasks', tasksRouter)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${server.address().port}/api`
})
after(async () => {
  queueEmitter.removeAllListeners()
  sseClients.clear()
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})
function request(path, options = {}) {
  return fetch(baseUrl + path, { ...options, headers: {
    Authorization: 'Bearer test-session', 'Content-Type': 'application/json', ...options.headers
  } })
}

test('generation requires login, disables caching, and does not create a task or operation log', async () => {
  const before = tasksDb.data.tasks.length
  const denied = await request('/cloud/oracle-account/instance-password', { headers: { Authorization: '' } })
  assert.equal(denied.status, 401)
  for (const provider of ['oracle', 'aws', 'azure']) {
    const response = await request(`/cloud/${provider}-account/instance-password`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).password.length, 20)
  }
  assert.equal(tasksDb.data.tasks.length, before)
  assert.equal(operationLogsDb.write.mock.callCount(), 0)
})

test('the password submitted during creation is retained across task updates and available only when done', async () => {
  const generated = await (await request('/cloud/oracle-account/instance-password')).json()
  const response = await request('/cloud/oracle-account/instances', {
    method: 'POST', body: JSON.stringify({ rootPassword: generated.password, shape: 'test-shape' })
  })
  assert.equal(response.status, 202)
  const { taskId } = await response.json()
  assert.equal(getTask(taskId).params.rootPassword, generated.password)
  assert.equal((await request(`/tasks/${taskId}/credentials`)).status, 409)
  await updateTask(taskId, { status: 'running', retries: 3 })
  await updateTask(taskId, { status: 'done', result: { instanceId: 'test-instance' } })
  const denied = await request(`/tasks/${taskId}/credentials`, { headers: { Authorization: '' } })
  assert.equal(denied.status, 401)
  const details = await request(`/tasks/${taskId}/credentials`)
  assert.equal(details.headers.get('cache-control'), 'no-store')
  const credentials = await details.json()
  assert.equal(credentials.password, generated.password)
  assert.equal(credentials.username, 'root')
  assert.equal(credentials.instanceId, 'test-instance')
  assert.equal(JSON.stringify(operationLogsDb.data.logs).includes(generated.password), false)
})

test('API and SSE task payloads redact passwords while retaining creation availability', async () => {
  const messages = []
  const client = { write: (message) => messages.push(message) }
  sseClients.add(client)
  const params = { provider: 'azure', adminUsername: 'saved-user', adminPassword: 'Test-only-Azure123!' }
  try {
    const task = await createTask('cloud:createInstance', 'azure-account', params)
    params.adminPassword = 'Changed-in-form123!'
    await updateTask(task.id, { status: 'done', result: { instanceId: 'azure-instance' } })
    assert.equal(getTask(task.id).params.adminPassword, 'Test-only-Azure123!')
    assert.equal(messages.some((message) => message.includes('Test-only-Azure123!')), false)
    assert.equal(messages.some((message) => message.includes('"hasCreationPassword":true')), true)
    const list = await (await request('/tasks')).json()
    assert.equal(JSON.stringify(list).includes('Test-only-Azure123!'), false)
    assert.equal(list.find((item) => item.id === task.id).hasCreationPassword, true)
    const credentials = await (await request(`/tasks/${task.id}/credentials`)).json()
    assert.equal(credentials.username, 'saved-user')
    assert.equal(credentials.password, 'Test-only-Azure123!')
  } finally { sseClients.delete(client) }
})

test('missing, unrelated and historical tasks never return invented credentials', async () => {
  const legacy = await createTask('cloud:createInstance', 'aws-account', { provider: 'aws' })
  await updateTask(legacy.id, { status: 'done' })
  const other = await createTask('other', 'oracle-account')
  await updateTask(other.id, { status: 'done' })
  assert.equal((await request('/tasks/nonexistent/credentials')).status, 404)
  assert.equal((await request(`/tasks/${legacy.id}/credentials`)).status, 404)
  assert.equal((await request(`/tasks/${other.id}/credentials`)).status, 400)
  assert.equal(getTasks().find((item) => item.id === legacy.id).hasCreationPassword, false)
})

test('AWS creation without a password generates and persists a unique password before enqueue', async () => {
  const ids = []
  for (let index = 0; index < 2; index++) {
    const response = await request('/cloud/aws-account/instances', { method: 'POST', body: '{}' })
    assert.equal(response.status, 202)
    ids.push((await response.json()).taskId)
  }
  const passwords = ids.map((id) => getTask(id).params.rootPassword)
  assert.equal(passwords.every((password) => password.length === 20), true)
  assert.notEqual(passwords[0], passwords[1])
  const cancelled = await request(`/tasks/${ids[0]}`, { method: 'DELETE' })
  assert.equal((await cancelled.text()).includes(passwords[0]), false)
})

test('worker retries and legacy AWS resumes keep the persisted password used by the provider', async (t) => {
  // Import only against the mocked provider registry; this never contacts a cloud.
  await import('../backend/workers/cloudWorker.mjs')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const observed = []
  provision = async (params) => {
    observed.push(params.rootPassword)
    if (observed.length === 1) throw new Error('Out of host capacity')
    return { instanceId: 'worker-test-instance' }
  }
  const task = { id: 'legacy-resume', type: 'cloud:createInstance', accountId: 'aws-account',
    params: { provider: 'aws', delay: 1 }, status: 'pending' }
  tasksDb.data.tasks.push(task)
  queueEmitter.emit('task:new', task)
  async function waitUntil(condition) {
    for (let index = 0; index < 100 && !condition(); index++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(condition(), true)
  }
  await waitUntil(() => task.statusMessage?.includes('资源不足'))
  const saved = task.params.rootPassword
  assert.equal(saved.length, 20)
  t.mock.timers.tick(1000)
  await waitUntil(() => task.status === 'done')
  assert.deepEqual(observed, [saved, saved])
  assert.equal((await (await request(`/tasks/${task.id}/credentials`)).json()).password, saved)
})
