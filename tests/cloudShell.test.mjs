import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { EventEmitter, once } from 'node:events'
import express from 'express'
import WebSocket from 'ws'

const accountsDb = { data: { accounts: [
  { id: 'aws', name: 'AWS test', computeProvider: 'aws', credentials: { accessKeyId: 'secret-access-id', secretAccessKey: 'secret-key' } },
  { id: 'azure', name: 'Azure test', computeProvider: 'azure', credentials: { tenant: 'tenant-id', password: 'secret-password', cliConfigText: 'secret-config' } },
  { id: 'oci', name: 'OCI test', computeProvider: 'oracle', credentials: { configProfile: 'WORK', privateKeyText: 'secret-private-key', configText: '[DEFAULT]\nregion=us-ashburn-1\ntenancy=other-tenant\n[WORK]\nregion=ap-tokyo-1\ntenancy=work-tenant\npass_phrase=secret-passphrase' } },
  { id: 'legacy', name: 'Legacy OCI', computeProvider: 'oracle', configProfile: 'WORK', configText: '[WORK]\nregion=eu-frankfurt-1\ntenancy=legacy-tenant' },
  { id: 'disabled', enabled: false, computeProvider: 'aws', credentials: { secret: 'secret-disabled' } }
] } }
const settingsDb = { data: { auth: { username: 'test', passwordHash: 'test-hash', passwordSalt: 'test-salt', sessions: [{ token: 'test-session' }] } }, write: async () => {} }
mock.module(new URL('../backend/db.mjs', import.meta.url).href, { namedExports: { accountsDb, settingsDb } })
const { default: router } = await import('../backend/routes/cloudShell.mjs')
const { authRequired } = await import('../backend/routes/auth.mjs')
const { TerminalSessions, terminalSessions, installTerminalWebSocket } = await import('../backend/services/terminalSessions.mjs')
let server, base, closeTerminals
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/cloud-shell', authRequired, router)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}/api/cloud-shell`
  closeTerminals = installTerminalWebSocket(server)
})
after(async () => { await closeTerminals(); await new Promise(resolve => server.close(resolve)) })

test('Rescue terminal account context requires a valid application login', async () => {
  assert.equal((await fetch(base)).status, 401)
  assert.equal((await fetch(base, { headers: { Authorization: 'Bearer invalid' } })).status, 401)
})

test('context excludes disabled accounts and credentials, and follows the selected OCI profile', async () => {
  const response = await fetch(base, { headers: { Authorization: 'Bearer test-session' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const data = await response.json()
  assert.equal(JSON.stringify(data).includes('secret-'), false)
  assert.deepEqual(data.accounts.map(({ capabilities, ...account }) => account), [
    { id: 'aws', name: 'AWS test', provider: 'aws', region: 'ap-southeast-1', tenant: '' },
    { id: 'azure', name: 'Azure test', provider: 'azure', region: '', tenant: 'tenant-id' },
    { id: 'oci', name: 'OCI test', provider: 'oracle', region: 'ap-tokyo-1', tenant: 'work-tenant' },
    { id: 'legacy', name: 'Legacy OCI', provider: 'oracle', region: 'eu-frankfurt-1', tenant: 'legacy-tenant' }
  ])
  assert.deepEqual(data.accounts.map(account => account.capabilities), [
    { serial: true }, { serial: true },
    { serial: true }, { serial: true }
  ])
})

const request = { accountId: 'aws', mode: 'serial', instanceId: 'i-0123456789abcdef0' }
const headers = { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('session API rejects disabled accounts, unsupported modes, malformed resource IDs and unauthenticated writes', async () => {
  assert.equal((await fetch(base + '/sessions', { method: 'POST' })).status, 401)
  for (const [body, status] of [
    [{ ...request, accountId: 'disabled' }, 404], [{ ...request, mode: 'cloudShell' }, 400],
    [{ ...request, accountId: 'azure', mode: 'cloudShell' }, 400],
    [{ ...request, instanceId: 'i-test; rm -rf /' }, 400], [{ ...request, mode: 'ssh' }, 400],
    [{ ...request, accountId: 'azure', instanceId: '/subscriptions/../../metadata' }, 400],
    [{ ...request, accountId: 'oci', instanceId: 'ocid1.instance.oc1.ap-singapore-1.test;id' }, 400],
    [{ ...request, accountId: 'oci', instanceId: 'ocid1.instance.oc1.ap-singapore-1.test/other' }, 400]
  ]) {
    assert.equal((await fetch(base + '/sessions', { method: 'POST', headers, body: JSON.stringify(body) })).status, status)
  }
})

test('Oracle instances in regions with hyphens can reserve and cancel a terminal session', async () => {
  for (const region of ['ap-singapore-1', 'ap-tokyo-1', 'iad']) {
    const response = await fetch(base + '/sessions', { method: 'POST', headers,
      body: JSON.stringify({ accountId: 'oci', mode: 'serial', instanceId: `ocid1.instance.oc1.${region}.fixture` }) })
    assert.equal(response.status, 201, `valid Oracle region ${region} must be accepted`)
    const { id } = await response.json()
    assert.equal((await fetch(base + '/sessions/' + id, { method: 'DELETE', headers })).status, 200)
  }
})

test('real WebSocket authenticates first frame, relays terminal bytes and resize, then cleans up on disconnect', async () => {
  const calls = []
  terminalSessions.connect = async (_account, target, ctx) => {
    calls.push(target)
    await ctx.defer(() => { calls.push('cleanup') })
    return { write: text => ctx.output(Buffer.from(text)), resize: size => { calls.push(size) } }
  }
  const response = await fetch(base + '/sessions', { method: 'POST', headers, body: JSON.stringify(request) })
  assert.equal(response.status, 201)
  const { id } = await response.json()
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket', { origin: new URL(base).origin })
  const messages = []
  ws.on('message', raw => messages.push(JSON.parse(raw)))
  await once(ws, 'open')
  assert.equal(calls.length, 0)
  const ready = new Promise(resolve => ws.on('message', raw => { if (JSON.parse(raw).type === 'ready') resolve() }))
  ws.send(JSON.stringify({ type: 'auth', token: 'test-session', sessionId: id }))
  await ready
  const output = new Promise(resolve => ws.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'output') resolve(message) }))
  ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
  ws.send(JSON.stringify({ type: 'input', data: '救援\u0003\r' }))
  assert.equal(Buffer.from((await output).data, 'base64').toString(), '救援\u0003\r')
  assert.deepEqual(calls[0], { mode: 'serial', instanceId: request.instanceId })
  assert.deepEqual(calls[1], { cols: 120, rows: 40 })
  const closed = once(ws, 'close')
  const session = terminalSessions.sessions.get(id)
  const serverClosed = once(session.socket, 'close')
  ws.close()
  await Promise.all([closed, serverClosed])
  await session.cleanupPromise
  assert.equal(calls.filter(item => item === 'cleanup').length, 1)
  assert.equal(terminalSessions.sessions.size, 0)
})

test('WebSocket refuses foreign origins before opening a terminal', async () => {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket', { origin: 'https://evil.example' })
  const error = await new Promise(resolve => ws.once('error', resolve))
  assert.match(error.message, /403/)
})

class FakeSocket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent = []
  send(raw) { this.sent.push(JSON.parse(raw)) }
  close(code) { this.readyState = 3; this.closeCode = code; this.emit('close') }
  terminate() { this.close(1006) }
  ping() {}
  frame(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false) }
}
function manager(connect, overrides = {}) {
  return new TerminalSessions({ getAccount: id => accountsDb.data.accounts.find(a => a.id === id),
    isAuthenticated: token => ['one', 'two'].includes(token), connect, ...overrides })
}

test('a session is owned by one login and its WebSocket can only be consumed once', async () => {
  let calls = 0
  const store = manager(async () => { calls++; return { write() {} } })
  const { id } = store.reserve('one', request)
  assert.throws(() => store.cancel(id, 'two'), /不存在/)
  const foreign = new FakeSocket()
  store.attach(foreign)
  foreign.frame({ type: 'auth', token: 'two', sessionId: id })
  assert.equal(foreign.closeCode, 1008)
  assert.equal(calls, 0)
  const valid = new FakeSocket()
  store.attach(valid)
  valid.frame({ type: 'auth', token: 'one', sessionId: id })
  await tick()
  const duplicate = new FakeSocket()
  store.attach(duplicate)
  duplicate.frame({ type: 'auth', token: 'one', sessionId: id })
  assert.equal(duplicate.closeCode, 1008)
  assert.equal(calls, 1)
  valid.close()
  await tick()
})

test('cancel during remote creation cleans up the late resource and holds the instance lock until then', async () => {
  let release, cleaned = 0
  const wait = new Promise(resolve => { release = resolve })
  const store = manager(async (_account, _request, ctx) => {
    await wait
    await ctx.defer(() => { cleaned++ })
    ctx.signal.throwIfAborted()
    return { write() {} }
  })
  const { id } = store.reserve('one', request)
  const socket = new FakeSocket()
  store.attach(socket)
  socket.frame({ type: 'auth', token: 'one', sessionId: id })
  await tick()
  store.cancel(id, 'one')
  assert.throws(() => store.reserve('two', request), /已有连接/)
  release()
  await store.sessions.get(id).cleanupPromise
  assert.equal(cleaned, 1)
  assert.equal(store.sessions.size, 0)
  assert.equal(socket.sent.some(message => message.type === 'ready'), false)
})

test('logout, idle expiry and unclaimed session expiry release resources', async () => {
  let clock = 0, authenticated = true, cleaned = 0
  const store = manager(async (_account, _request, ctx) => {
    await ctx.defer(() => { cleaned++ })
    return { write() {} }
  }, { now: () => clock, isAuthenticated: () => authenticated, limits: { idle: 10, pending: 10 } })
  let { id } = store.reserve('one', request)
  clock = 11
  store.sweep()
  await tick()
  assert.equal(store.sessions.size, 0)
  for (const expire of ['idle', 'logout']) {
    ;({ id } = store.reserve('one', request))
    const socket = new FakeSocket()
    store.attach(socket)
    socket.frame({ type: 'auth', token: 'one', sessionId: id })
    await tick()
    if (expire === 'idle') clock += 11
    else authenticated = false
    store.sweep()
    await tick()
    assert.equal(store.sessions.size, 0)
  }
  assert.equal(cleaned, 2)
})

test('reconnecting after refresh waits for the previous owned session to finish cleanup', async () => {
  let release
  const cleanup = new Promise(resolve => { release = resolve })
  const store = manager(async (_account, _request, ctx) => {
    await ctx.defer(() => cleanup)
    return { write() {} }
  })
  const { id } = store.reserve('one', request)
  const socket = new FakeSocket()
  store.attach(socket)
  socket.frame({ type: 'auth', token: 'one', sessionId: id })
  await tick()
  socket.close()
  let ready = false
  const waiting = store.waitForCleanup('one', request).then(() => { ready = true })
  await tick()
  assert.equal(ready, false)
  await store.waitForCleanup('two', request)
  assert.throws(() => store.reserve('two', request), /已有连接/)
  release()
  await waiting
  const next = store.reserve('one', request)
  await store.cancel(next.id, 'one')
  assert.equal(store.sessions.size, 0)
})

test('oversized input and output backlog close the session instead of buffering indefinitely', async () => {
  const store = manager(async () => ({ write() {} }))
  const { id } = store.reserve('one', request)
  const socket = new FakeSocket()
  store.attach(socket)
  socket.frame({ type: 'auth', token: 'one', sessionId: id })
  await tick()
  socket.frame({ type: 'input', data: 'x'.repeat(17000) })
  await tick()
  assert.equal(store.sessions.size, 0)
  const next = store.reserve('one', request)
  const second = new FakeSocket()
  store.attach(second)
  second.frame({ type: 'auth', token: 'one', sessionId: next.id })
  await tick()
  second.bufferedAmount = 2 * 1024 * 1024
  store.send(store.sessions.get(next.id), { type: 'output', data: 'test' })
  await tick()
  assert.equal(store.sessions.size, 0)
})
