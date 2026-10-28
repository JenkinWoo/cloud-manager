import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { once } from 'node:events'
import express from 'express'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const account = { id: 'azure-account', name: 'Azure', computeProvider: 'azure', credentials: { password: 'cloud-secret-123', subscriptionId: 'sub' } }
const settingsDb = { data: { auth: { username: 'admin', passwordHash: 'test-hash', passwordSalt: 'test-salt', sessions: [{ token: 'browser-session' }] } }, write: mock.fn(async () => {}) }
const tasksDb = { data: { tasks: [] }, write: async () => {} }
const logs = []
const listInstances = mock.fn(async () => [{ id: 'vm', displayName: 'VM', raw: { password: 'raw-secret' }, adminPassword: 'password-value' }])
const instanceAction = mock.fn(async () => ({ success: true }))
const prepareFreeCreate = mock.fn(async params => ({ ...params, location: 'westus', vmSize: 'Standard_B2pts_v2' }))
const subscriptions = []
mock.module(new URL('../backend/db.mjs', import.meta.url).href, { namedExports: {
  settingsDb, tasksDb, accountsDb: { data: { accounts: [account, { id: 'disabled', enabled: false }] } },
  dnsAccountsDb: { data: { dnsAccounts: [{ id: 'dns', name: 'DNS', dnsProvider: 'cloudflare', credentials: { apiToken: 'dns-secret-123' } }] } }
} })
mock.module(new URL('../backend/providers/registry.mjs', import.meta.url).href, { namedExports: {
  getComputeProvider: () => ({ useSubscription: id => subscriptions.push(id), listInstances, instanceAction, prepareFreeCreate,
    listEligibleSubscriptions: async () => [{ subscriptionId: 'sub' }], listCreateOptions: async () => ({ options: [] }),
    getBilling: async () => ({ total: 1, services: [], status: 'ok' }) }),
  getDnsProvider: () => ({ listRecords: async () => [{ name: 'example.test', type: 'A', content: '192.0.2.1' }] })
} })
mock.module(new URL('../backend/utils/operationLog.mjs', import.meta.url).href, { namedExports: { appendOperationLog: async entry => logs.push(entry) } })
const auth = await import('../backend/utils/mcpAuth.mjs')
const { default: mcpRouter } = await import('../backend/routes/mcp.mjs')
const { default: settingsRouter } = await import('../backend/routes/mcpSettings.mjs')
const { authRequired } = await import('../backend/routes/auth.mjs')
const app = express()
app.use('/mcp', mcpRouter)
app.use('/api/settings/mcp', express.json(), authRequired, settingsRouter)
const httpServer = app.listen(0, '127.0.0.1')
await once(httpServer, 'listening')
const base = `http://127.0.0.1:${httpServer.address().port}`
const clients = []
after(async () => {
  await Promise.all(clients.map(client => client.close().catch(() => {})))
  await new Promise(resolve => httpServer.close(resolve))
})
async function connect(token) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}
const tokenInput = { name: 'test-client', mode: 'read', expiresInDays: 90 }
const parse = result => JSON.parse(result.content[0].text)

test('settings validate input, default to read-only, and expose the token only once', async () => {
  assert.equal(auth.getMcpSettings().enabled, false)
  const post = body => fetch(base + '/api/settings/mcp/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer browser-session' }, body: JSON.stringify(body) })
  assert.equal((await post({ name: 'bad', mode: 'admin' })).status, 400)
  assert.equal((await post({ name: 'bad', expiresInDays: 0 })).status, 400)
  const response = await post({ name: 'default' })
  assert.equal(response.status, 201)
  const created = await response.json()
  assert.equal(created.mode, 'read')
  assert.match(created.token, /^cm_mcp_[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(settingsDb.data).includes(created.token))
  assert.equal((await fetch(base + '/api/settings/mcp')).status, 401)
  assert.equal((await fetch(base + '/api/settings/mcp', { headers: { Authorization: `Bearer ${created.token}` } })).status, 401)
  const safe = await (await fetch(base + '/api/settings/mcp', { headers: { Authorization: 'Bearer browser-session' } })).text()
  assert.ok(!safe.includes(created.token))
  assert.ok(!safe.includes('tokenHash'))
  await assert.rejects(auth.saveMcpSettings({ enabled: true, allowedOrigins: ['https://client.test/path'] }))
  await assert.rejects(auth.saveMcpSettings({ enabled: true, allowedOrigins: ['https://*.client.test'] }))
  assert.equal(auth.getMcpSettings().enabled, false)
  await auth.saveMcpSettings({ enabled: true, allowedOrigins: ['https://client.test'] })
})

test('official MCP client initializes, discovers read tools, and cannot invoke writes', async () => {
  const token = await auth.createMcpToken(tokenInput)
  const client = await connect(token.token)
  const { tools } = await client.listTools()
  assert.ok(tools.some(t => t.name === 'list_accounts'))
  assert.ok(tools.every(t => t.annotations.readOnlyHint))
  assert.ok(!tools.some(t => t.name === 'create_instance'))
  const accounts = parse(await client.callTool({ name: 'list_accounts', arguments: {} }))
  assert.deepEqual(accounts.compute, [{ id: account.id, name: account.name, provider: 'azure' }])
  assert.ok(!JSON.stringify(accounts).includes('secret'))
  const denied = await client.callTool({ name: 'instance_action', arguments: { accountId: account.id, subscriptionId: 'sub', instanceId: 'vm', action: 'START' } })
  assert.equal(denied.isError, true)
  assert.equal(instanceAction.mock.callCount(), 0)
  const missingScope = await client.callTool({ name: 'list_instances', arguments: { accountId: account.id } })
  assert.equal(missingScope.isError, true)
  assert.equal(listInstances.mock.callCount(), 0)
  const result = await client.callTool({ name: 'list_instances', arguments: { accountId: account.id, subscriptionId: 'sub' } })
  assert.deepEqual(parse(result), [{ id: 'vm', displayName: 'VM' }])
  assert.equal(subscriptions.at(-1), 'sub')
  const invalid = await client.callTool({ name: 'list_instances', arguments: { accountId: account.id, subscriptionId: 'sub', unexpected: 'field' } })
  assert.equal(invalid.isError, true)
  assert.equal(listInstances.mock.callCount(), 1)
  await auth.revokeMcpToken(token.id)
  await assert.rejects(client.listTools(), /invalid\/expired/)
})

test('HTTP boundary rejects missing/query/session/expired tokens, disabled service and unapproved origins', async () => {
  const token = await auth.createMcpToken(tokenInput)
  const headers = { Authorization: `Bearer ${token.token}` }
  for (const suffix of ['', '?token=' + token.token]) assert.equal((await fetch(base + '/mcp' + suffix)).status, 401)
  assert.equal((await fetch(base + '/mcp', { headers: { Authorization: 'Bearer browser-session' } })).status, 401)
  assert.equal((await fetch(base + '/mcp', { headers })).status, 405)
  assert.equal((await fetch(base + '/mcp', { method: 'DELETE', headers })).status, 405)
  assert.equal((await fetch(base + '/mcp/unknown', { headers })).status, 404)
  assert.equal((await fetch(base + '/mcp', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403)
  const preflight = await fetch(base + '/mcp', { method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': 'POST' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://client.test')
  const stored = settingsDb.data.mcp.tokens.find(t => t.id === token.id)
  stored.expiresAt = '2000-01-01T00:00:00.000Z'
  assert.equal((await fetch(base + '/mcp', { headers })).status, 401)
  stored.expiresAt = '2099-01-01T00:00:00.000Z'
  await auth.saveMcpSettings({ enabled: false, allowedOrigins: [] })
  assert.equal((await fetch(base + '/mcp', { headers })).status, 401)
  await auth.saveMcpSettings({ enabled: true, allowedOrigins: [] })
})

test('write tokens use the shared Azure preflight/queue, preserve secrets internally, and redact tasks/errors/audit', async () => {
  const token = await auth.createMcpToken({ ...tokenInput, mode: 'write' })
  const client = await connect(token.token)
  assert.ok((await client.listTools()).tools.some(t => t.name === 'create_instance'))
  const password = 'Create-password-123!'
  const create = params => client.callTool({ name: 'create_instance', arguments: { accountId: account.id, subscriptionId: 'sub', adminPassword: password, ...params } })
  assert.equal((await create({ vmSize: 'Standard_D4s_v3' })).isError, true)
  assert.equal(tasksDb.data.tasks.length, 0)
  prepareFreeCreate.mock.mockImplementationOnce(async () => { throw new Error('benefit expired cloud-secret-123 Create-password-123!') })
  const failed = await create({})
  assert.equal(failed.isError, true)
  assert.ok(!JSON.stringify(failed).includes(password))
  assert.ok(!JSON.stringify(failed).includes('cloud-secret-123'))
  assert.equal(tasksDb.data.tasks.length, 0)
  const result = await create({})
  assert.ok(!result.isError)
  const task = tasksDb.data.tasks.at(-1)
  assert.equal(task.params.adminPassword, password)
  assert.equal(task.params.vmSize, 'Standard_B2pts_v2')
  assert.equal(task.params.createPublicIp, false)
  task.error = 'provider echoed ' + password
  const response = await client.callTool({ name: 'get_task', arguments: { taskId: task.id } })
  assert.ok(!JSON.stringify(response).includes(password))
  assert.ok(!('params' in parse(response)))
  const actionArgs = { accountId: account.id, subscriptionId: 'sub', instanceId: '/subscriptions/other/resourceGroups/group/providers/Microsoft.Compute/virtualMachines/vm', action: 'STOP' }
  assert.equal((await client.callTool({ name: 'instance_action', arguments: actionArgs })).isError, true)
  assert.equal(instanceAction.mock.callCount(), 0)
  actionArgs.instanceId = actionArgs.instanceId.replace('/other/', '/sub/')
  assert.ok(!(await client.callTool({ name: 'instance_action', arguments: actionArgs })).isError)
  assert.equal(instanceAction.mock.callCount(), 1)
  assert.ok(logs.some(entry => entry.action === 'create_instance' && entry.metadata.mcpTokenId === token.id))
  const audit = JSON.stringify(logs)
  for (const secret of [password, token.token, 'cloud-secret-123']) assert.ok(!audit.includes(secret))
})

test('malformed and oversized bodies do not leak execution slots', async () => {
  const token = await auth.createMcpToken(tokenInput)
  const headers = { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' }
  for (let i = 0; i < 10; i++) assert.equal((await fetch(base + '/mcp', { method: 'POST', headers, body: '{bad' })).status, 400)
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(140000) }) })).status, 413)
  const client = await connect(token.token)
  assert.ok((await client.listTools()).tools.length > 0)
})

test('concurrent requests are bounded and slots are released after slow calls finish', async () => {
  const token = await auth.createMcpToken(tokenInput)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let allStarted
  const started = new Promise(resolve => { allStarted = resolve })
  let count = 0
  listInstances.mock.mockImplementation(async () => {
    if (++count === 8) allStarted()
    await blocked
    return []
  })
  const headers = { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_instances', arguments: { accountId: account.id, subscriptionId: 'sub' } } })
  const pending = Array.from({ length: 8 }, () => fetch(base + '/mcp', { method: 'POST', headers, body }))
  try {
    await started
    const limited = await fetch(base + '/mcp', { method: 'POST', headers, body })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '60')
    assert.equal(count, 8)
  } finally { release() }
  for (const response of await Promise.all(pending)) { assert.equal(response.status, 200); await response.json() }
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers, body })).status, 200)
})

test('rate limiting applies per token and failed persistence rolls back token creation', async () => {
  const token = await auth.createMcpToken(tokenInput)
  const headers = { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  for (let i = 0; i < 120; i++) {
    const response = await fetch(base + '/mcp', { method: 'POST', headers, body })
    assert.equal(response.status, 200)
    await response.json()
  }
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers, body })).status, 429)
  const before = structuredClone(settingsDb.data.mcp)
  settingsDb.write.mock.mockImplementationOnce(async () => { throw new Error('disk unavailable') })
  await assert.rejects(auth.createMcpToken(tokenInput), /disk unavailable/)
  assert.deepEqual(settingsDb.data.mcp, before)
  const another = await auth.createMcpToken(tokenInput)
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${another.token}` }, body })).status, 200)
})
