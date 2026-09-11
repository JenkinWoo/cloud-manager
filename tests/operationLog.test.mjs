import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { once } from 'node:events'
import express from 'express'

// No real account, log or settings files are read or written by these tests.
const logStore = { data: { logs: [] }, write: mock.fn(async () => {}) }
const settingsStore = { data: { operationLogs: { retentionDays: 30 }, auth: {
  username: 'test-user', passwordHash: 'test-only-hash', passwordSalt: 'test-only-salt',
  sessions: [{ token: 'test-session' }]
} }, write: mock.fn(async () => {}) }
mock.module(new URL('../backend/db.mjs', import.meta.url).href, { namedExports: {
  accountsDb: { data: { accounts: [{ id: 'test-account', name: '测试账户' }] } },
  operationLogsDb: logStore,
  settingsDb: settingsStore
} })
const { default: logsRouter } = await import('../backend/routes/logs.mjs')
const { authRequired } = await import('../backend/routes/auth.mjs')
const { operationLogMiddleware } = await import('../backend/utils/operationLog.mjs')

const original = {
  id: 'older-log', createdAt: '2026-01-01T01:02:03.000Z', operator: 'test-user',
  action: '执行实例操作: STOP', resource: '云资源', target: 'ocid1.instance.test',
  method: 'POST', path: '/api/cloud/test-account/instances/ocid1.instance.test/action',
  metadata: { instanceName: '测试实例', requestId: 'provider-request-123' },
  result: 'failed', statusCode: 400, durationMs: 0, ip: '192.0.2.25', userAgent: 'Test Client',
  error: 'InvalidParameter: IP address\n' + '完整错误信息'.repeat(1000)
}
logStore.data.logs = [original, ...Array.from({ length: 501 }, (_, index) => ({
  id: `recent-${index}`, createdAt: '2026-01-02T00:00:00.000Z', result: 'success'
}))]

let server
let baseUrl
before(async () => {
  const app = express()
  app.use(operationLogMiddleware)
  app.use('/api/logs', authRequired, logsRouter)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${server.address().port}/api/logs`
})
after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})
function get(path, authenticated = true) {
  return fetch(baseUrl + path, { headers: authenticated ? { Authorization: 'Bearer test-session' } : {} })
}

test('log details remain protected by the existing login middleware', async () => {
  const response = await get('/older-log', false)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: '未登录' })
})

test('details can retrieve retained logs outside the list limit without truncating errors', async () => {
  const list = await (await get('?limit=500')).json()
  assert.equal(list.length, 500)
  assert.equal(list.some((item) => item.id === original.id), false)
  const response = await get('/older-log')
  assert.equal(response.status, 200)
  const detail = await response.json()
  assert.equal(detail.id, original.id)
  assert.equal(detail.error, original.error)
  assert.equal(detail.durationMs, 0)
  assert.equal(detail.path, original.path)
  assert.deepEqual(detail.metadata, original.metadata)
  assert.equal(detail.target, '测试账户 / 测试实例')
  assert.equal(detail.action, '执行实例停止操作')
  assert.equal(original.action, '执行实例操作: STOP')
})

test('missing and cleaned logs return an explicit 404 instead of another record', async () => {
  const response = await get('/cleaned-log')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: '日志不存在或已被清理' })
})

test('legacy logs without optional detail fields remain queryable', async () => {
  const response = await get('/recent-0')
  assert.equal(response.status, 200)
  const detail = await response.json()
  assert.equal(detail.id, 'recent-0')
  assert.equal(detail.metadata, undefined)
  assert.equal(detail.userAgent, undefined)
})

test('list search locates retained logs by ID and source IP before applying the limit', async () => {
  for (const keyword of ['older-log', '192.0.2.25']) {
    const response = await get(`?keyword=${encodeURIComponent(keyword)}&limit=1`)
    assert.deepEqual((await response.json()).map((item) => item.id), ['older-log'])
  }
})

test('querying details and missing records does not append or persist operation logs', async () => {
  const before = JSON.stringify(logStore.data.logs)
  await get('/older-log')
  await get('/cleaned-log')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(JSON.stringify(logStore.data.logs), before)
  assert.equal(logStore.write.mock.callCount(), 0)
})
