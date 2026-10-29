import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { after, mock, test } from 'node:test'

// Exercise provider protocols without real credentials, cloud writes or SSH access.
const calls = []
const clients = []
const sockets = []
const publicHostKey = Buffer.from('fixture-ssh-host-key')
const consoleHostKey = Buffer.from('fixture-distinct-instance-console-key')
const fingerprint = 'SHA256:' + createHash('sha256').update(publicHostKey).digest('base64').replace(/=+$/, '')
const instanceId = 'ocid1.instance.oc1.ap-singapore-1.test'
const connectionId = 'ocid1.instanceconsoleconnection.oc1.ap-singapore-1.test'
let oracleConflict = false
let oracleUntrustedProxy = false
let awsEnabled = true
let awsKeyAccepted = true
class Channel extends EventEmitter {
  stderr = new EventEmitter()
  writableLength = 0
  write(data) { calls.push(['input', data]) }
  setWindow(...args) { calls.push(['size', ...args]) }
  close() { this.emit('close') }
  destroy() { this.emit('close') }
}
class SshClient extends EventEmitter {
  constructor() { super(); clients.push(this) }
  connect(config) {
    this.config = config
    queueMicrotask(() => {
      // OCI's proxy and inner console advertise ECDSA, with distinct host keys.
      const oracle = config.port === 443 || Boolean(config.sock)
      if (oracle && config.algorithms?.serverHostKey && !config.algorithms.serverHostKey.includes('ecdsa-sha2-nistp256')) {
        this.emit('error', new Error('Handshake failed: no matching host key format'))
        return
      }
      const key = config.sock ? consoleHostKey : oracle && oracleUntrustedProxy ? Buffer.from('untrusted-proxy') : publicHostKey
      if (oracle && config.hostVerifier && !config.hostVerifier(key)) {
        this.emit('error', new Error('Host denied (verification failed)'))
        return
      }
      this.emit('ready')
    })
  }
  forwardOut(...args) { calls.push(['tunnel', ...args.slice(0, 4)]); args.at(-1)(null, new Channel()) }
  shell(options, callback) { this.channel = new Channel(); calls.push(['pty', options]); callback(null, this.channel) }
  destroy() { this.emit('close') }
}
mock.module('ssh2', { defaultExport: { Client: SshClient, utils: { generateKeyPair: (_type, _options, callback) => callback(null, { public: 'ssh-rsa fixture-public', private: 'fixture-private' }) } } })
mock.module(new URL('../backend/providers/registry.mjs', import.meta.url).href, { namedExports: {
  getComputeProvider: () => ({ _ensureInitialized: async () => {}, computeClient: {
    createInstanceConsoleConnection: async request => {
      calls.push(['oracle-create', request])
      if (oracleConflict) throw { statusCode: 409 }
      return { instanceConsoleConnection: { id: connectionId, instanceId, lifecycleState: 'ACTIVE', serviceHostKeyFingerprint: fingerprint,
        connectionString: `ssh -o ProxyCommand='ssh -W %h:%p -p 443 ${connectionId}@instance-console.ap-singapore-1.oci.oraclecloud.com' ${instanceId}` } }
    },
    deleteInstanceConsoleConnection: async request => { calls.push(['oracle-delete', request]) },
    getInstanceConsoleConnection: async () => ({ instanceConsoleConnection: { lifecycleState: 'DELETED' } })
  } })
} })
mock.module('aws-sdk', { defaultExport: {
  EC2: class { getSerialConsoleAccessStatus() { return { promise: async () => ({ SerialConsoleAccessEnabled: awsEnabled }) } } },
  EC2InstanceConnect: class { sendSerialConsoleSSHPublicKey(request) { calls.push(['aws-key', request]); return { promise: async () => ({ Success: awsKeyAccepted }) } } }
} })
class Credential {
  constructor(options) { this.options = options }
  async getToken(scope) {
    calls.push(['token-scope', scope])
    return { token: 'fixture-access-token' }
  }
}
mock.module('@azure/identity', { namedExports: { ClientSecretCredential: Credential } })
class RemoteSocket extends EventEmitter {
  bufferedAmount = 0
  constructor(url, options) {
    super(); this.url = new URL(url); this.options = options; this.sent = []; sockets.push(this)
    queueMicrotask(() => { this.emit('open'); if (this.url.hostname.includes('serialconsole')) this.emit('message', Buffer.from('challenge')) })
  }
  send(data, options) { this.sent.push({ data, options }) }
  terminate() { this.emit('close') }
}
mock.module('ws', { defaultExport: RemoteSocket })
const { connectCloudTerminal, deleteOracleConsoleConnection, verifyFingerprint, parseOracleConsole, azureEndpoint } = await import('../backend/services/cloudTerminalProviders.mjs')
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })

function context() {
  const controller = new AbortController()
  const cleanups = []
  const output = []
  return { controller, signal: controller.signal, size: { cols: 100, rows: 30 },
    defer: async fn => { cleanups.push(fn) }, output: data => output.push(data), outputData: output,
    status() {}, fail() {}, end() {},
    close: async () => { for (const fn of cleanups.reverse()) await fn() }
  }
}

test('Oracle uses API-provided SSH endpoints and ephemeral key, then deletes only its own connection', async () => {
  calls.length = 0
  const ctx = context()
  const transport = await connectCloudTerminal({ computeProvider: 'oracle' }, { mode: 'serial', instanceId }, ctx)
  assert.deepEqual(calls.find(c => c[0] === 'oracle-create')[1], { createInstanceConsoleConnectionDetails: { instanceId, publicKey: 'ssh-rsa fixture-public' } })
  assert.equal(clients.at(-2).config.host, 'instance-console.ap-singapore-1.oci.oraclecloud.com')
  assert.equal(clients.at(-2).config.port, 443)
  assert.equal(clients.at(-2).config.username, connectionId)
  assert.equal(clients.at(-2).config.hostVerifier(publicHostKey), true)
  assert.equal(clients.at(-2).config.hostVerifier(Buffer.from('wrong')), false)
  assert.ok(clients.at(-1).config.sock, 'inner console must use the authenticated proxy tunnel')
  assert.equal(clients.at(-1).config.host, undefined, 'inner console must not dial a separate host')
  assert.deepEqual(calls.find(c => c[0] === 'tunnel').slice(1), ['127.0.0.1', 0, instanceId, 22])
  transport.write('uname -a\r')
  transport.resize({ cols: 120, rows: 40 })
  clients.at(-1).channel.emit('data', Buffer.from('Linux'))
  assert.equal(ctx.outputData[0].toString(), 'Linux')
  assert.deepEqual(calls.find(c => c[0] === 'size'), ['size', 40, 120, 0, 0])
  await ctx.close()
  assert.deepEqual(calls.filter(c => c[0] === 'oracle-delete'), [['oracle-delete', { instanceConsoleConnectionId: connectionId }]])
})

test('Oracle rejects an untrusted proxy before opening an instance tunnel and cleans up its connection', async () => {
  calls.length = 0
  oracleUntrustedProxy = true
  const ctx = context()
  try { await assert.rejects(connectCloudTerminal({ computeProvider: 'oracle' }, { mode: 'serial', instanceId }, ctx), /主机指纹校验失败/) }
  finally { oracleUntrustedProxy = false; await ctx.close() }
  assert.equal(calls.some(c => c[0] === 'tunnel'), false)
  assert.deepEqual(calls.filter(c => c[0] === 'oracle-delete'), [['oracle-delete', { instanceConsoleConnectionId: connectionId }]])
})

test('Oracle connection conflict never deletes another user connection', async () => {
  calls.length = 0
  oracleConflict = true
  const ctx = context()
  try { await assert.rejects(connectCloudTerminal({ computeProvider: 'oracle' }, { mode: 'serial', instanceId }, ctx), /已有 Console Connection/) }
  finally { oracleConflict = false; await ctx.close() }
  assert.equal(calls.some(c => c[0] === 'oracle-delete'), false)
})

test('Oracle cleanup waits for cloud deletion and treats an absent connection as released', async () => {
  const requests = []
  let release
  let completed = false
  const deleted = new Promise(resolve => { release = resolve })
  const cleanup = deleteOracleConsoleConnection({
    deleteInstanceConsoleConnection: async request => { requests.push(request) },
    getInstanceConsoleConnection: async request => { requests.push(request); return deleted }
  }, connectionId).then(() => { completed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false, 'DELETE acknowledgement must not release the instance lock')
  release({ instanceConsoleConnection: { lifecycleState: 'DELETED' } })
  await cleanup
  assert.deepEqual(requests, Array(2).fill({ instanceConsoleConnectionId: connectionId }))
  await deleteOracleConsoleConnection({ deleteInstanceConsoleConnection: async () => { throw { statusCode: 404 } } }, connectionId)
  await deleteOracleConsoleConnection({
    deleteInstanceConsoleConnection: async () => {},
    getInstanceConsoleConnection: async () => { throw { statusCode: 404 } }
  }, connectionId)
  await assert.rejects(deleteOracleConsoleConnection({ deleteInstanceConsoleConnection: async () => { throw new Error('denied') } }, connectionId), /denied/)
})

test('AWS requires existing account access and connects to its documented endpoint with a one-use key', async () => {
  const account = { computeProvider: 'aws', credentials: { region: 'ap-southeast-1' } }
  const request = { mode: 'serial', instanceId: 'i-0123456789abcdef0' }
  let ctx = context()
  awsEnabled = false
  await assert.rejects(connectCloudTerminal(account, request, ctx), /尚未启用/)
  awsEnabled = true
  awsKeyAccepted = false
  await assert.rejects(connectCloudTerminal(account, request, ctx), /未接受临时/)
  awsKeyAccepted = true
  ctx = context()
  await connectCloudTerminal(account, request, ctx)
  assert.equal(clients.at(-1).config.host, 'serial-console.ec2-instance-connect.ap-southeast-1.aws')
  assert.equal(clients.at(-1).config.username, request.instanceId + '.port0')
  assert.equal(typeof clients.at(-1).config.hostVerifier, 'function')
  await ctx.close()
})

test('Azure serial requests the ARM resource and authenticates the upstream socket without exposing token in URL', async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ connectionString: 'wss://eastus.gateway.serialconsole.azure.com/n/connector/test/sessions/test/client' }))
  }
  const ctx = context()
  const target = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/test'
  const transport = await connectCloudTerminal({ computeProvider: 'azure', credentials: { tenant: 'test', appId: 'test', password: 'test' } }, { mode: 'serial', instanceId: target }, ctx)
  assert.equal(requests[0].url, `https://management.azure.com${target}/providers/Microsoft.SerialConsole/serialPorts/0/connect?api-version=2024-07-01`)
  assert.equal(sockets.at(-1).url.href.includes('fixture-access-token'), false)
  assert.equal(sockets.at(-1).sent[0].data, 'fixture-access-token')
  sockets.at(-1).emit('message', Buffer.from('login:'))
  assert.equal(sockets.at(-1).sent.filter(item => item.data === 'fixture-access-token').length, 1)
  assert.equal(ctx.outputData[0].toString(), 'login:')
  transport.write('root\r')
  assert.equal(sockets.at(-1).sent.at(-1).data, 'root\r')
  await ctx.close()
})

test('host verification and endpoint validation refuse untrusted destinations', () => {
  assert.equal(verifyFingerprint(publicHostKey, fingerprint), true)
  assert.equal(verifyFingerprint(publicHostKey, 'SHA256:wrong'), false)
  assert.throws(() => parseOracleConsole({ connectionString: `${connectionId}@evil.example`, id: connectionId, instanceId, serviceHostKeyFingerprint: fingerprint }, instanceId), /未返回可验证/)
  for (const value of ['wss://evil.example/', 'ws://eastus.gateway.serialconsole.azure.com/', 'wss://eastus.gateway.serialconsole.azure.com.evil.example/', 'wss://user:secret@eastus.gateway.serialconsole.azure.com/']) {
    assert.throws(() => azureEndpoint(value))
  }
  assert.throws(() => azureEndpoint('wss://test.console.azure.com/'))
  assert.throws(() => azureEndpoint('wss://test.servicebus.windows.net/'))
})
