import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import ssh2 from 'ssh2'
import WebSocket from 'ws'
import { ClientSecretCredential } from '@azure/identity'
import { normalizeAzureCredentials } from '../utils/azureCredentials.mjs'
import { awsSerialEndpoints } from '../utils/awsSerialEndpoints.mjs'

const { Client, utils: sshUtils } = ssh2

function publicError(message) { return Object.assign(new Error(message), { userMessage: message }) }
function check(ctx) { ctx.signal.throwIfAborted() }

export function verifyFingerprint(key, expected) {
  const actual = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return actual === String(expected || '').replace(/^SHA256:/, '').replace(/=+$/, '')
}

export function parseOracleConsole(connection, instanceId) {
  // Extract only identifiers from the provider response; never execute its SSH command.
  const match = String(connection.connectionString || '').match(/(ocid1\.instanceconsoleconnection\.[a-z0-9.-]+)@([a-z0-9.-]+)/i)
  if (!match || match[1] !== connection.id || !/^instance-console\.[a-z0-9-]+\.oci\.oraclecloud\.com$/.test(match[2]) || !connection.serviceHostKeyFingerprint) {
    throw publicError('Oracle 未返回可验证的商业区串口连接信息；当前不支持该区域的控制台端点')
  }
  if (connection.instanceId !== instanceId) throw publicError('Oracle 返回的控制台实例与目标不一致')
  return { username: match[1], host: match[2], fingerprint: connection.serviceHostKeyFingerprint }
}

async function keyPair() {
  return new Promise((resolve, reject) => sshUtils.generateKeyPair('rsa', { bits: 2048 }, (error, pair) => error ? reject(error) : resolve(pair)))
}

export async function deleteOracleConsoleConnection(computeClient, connectionId) {
  const request = { instanceConsoleConnectionId: connectionId }
  try { await computeClient.deleteInstanceConsoleConnection(request) }
  catch (error) { if (error.statusCode === 404) return; throw error }
  // OCI deletion is asynchronous. Keep the instance lock until the console is
  // actually released, even though the terminal's abort signal is already set.
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const { instanceConsoleConnection } = await computeClient.getInstanceConsoleConnection(request)
      if (instanceConsoleConnection.lifecycleState === 'DELETED') return
    } catch (error) { if (error.statusCode === 404) return; throw error }
    await delay(1500)
  }
  throw publicError('Oracle 控制台连接仍在删除中，请稍后重试')
}

async function sshConnect(config, ctx) {
  check(ctx)
  const client = new Client()
  await ctx.defer(() => client.destroy())
  check(ctx)
  return new Promise((resolve, reject) => {
    let ready = false
    client.on('ready', () => { ready = true; resolve(client) })
    client.on('error', error => { if (!ready) reject(error); else ctx.fail() })
    client.on('close', () => { if (!ready) reject(new Error('SSH connection closed')); else ctx.end('云端串口连接已关闭') })
    client.connect({ readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3, ...config })
  })
}

async function sshTerminal(client, ctx) {
  check(ctx)
  const stream = await new Promise((resolve, reject) => client.shell({ term: 'xterm-256color', ...ctx.size }, (error, channel) => error ? reject(error) : resolve(channel)))
  await ctx.defer(() => stream.close())
  check(ctx)
  stream.on('data', ctx.output)
  stream.stderr.on('data', ctx.output)
  stream.on('error', ctx.fail)
  stream.on('close', () => ctx.end('串口连接已断开'))
  return {
    write: data => { if (stream.writableLength > 262144) ctx.end('远端处理输入过慢'); else stream.write(data) },
    resize: ({ cols, rows }) => stream.setWindow(rows, cols, 0, 0)
  }
}

async function oracleSerial(account, request, ctx) {
  const { getComputeProvider } = await import('../providers/registry.mjs')
  const provider = getComputeProvider(account)
  await provider._ensureInitialized()
  check(ctx)
  const keys = await keyPair()
  check(ctx)
  let connection
  try {
    const response = await provider.computeClient.createInstanceConsoleConnection({ createInstanceConsoleConnectionDetails: {
      instanceId: request.instanceId, publicKey: keys.public
    } })
    connection = response.instanceConsoleConnection
  } catch (error) {
    if (error.statusCode === 409) throw publicError('实例已有 Console Connection，请先在原连接处断开并删除后重试；不会替你删除已有连接')
    throw publicError('Oracle 串口创建失败，请检查实例所在区域及 instance-console-connection 权限')
  }
  if (!connection?.id) throw publicError('Oracle 未返回控制台连接 ID')
  await ctx.defer(async () => {
    // Delete only the connection created by this session, including after a canceled startup.
    await deleteOracleConsoleConnection(provider.computeClient, connection.id)
  })
  ctx.status('正在等待 Oracle 串口连接就绪…')
  for (let attempt = 0; connection.lifecycleState !== 'ACTIVE'; attempt++) {
    check(ctx)
    if (attempt >= 40 || ['FAILED', 'DELETED', 'DELETING'].includes(connection.lifecycleState)) throw publicError('Oracle 控制台连接未能就绪，请稍后重试')
    await delay(1500, undefined, { signal: ctx.signal })
    connection = (await provider.computeClient.getInstanceConsoleConnection({ instanceConsoleConnectionId: connection.id })).instanceConsoleConnection
  }
  check(ctx)
  const endpoint = parseOracleConsole(connection, request.instanceId)
  const proxy = await sshConnect({ host: endpoint.host, port: 443, username: endpoint.username,
    privateKey: keys.private, hostVerifier: key => verifyFingerprint(key, endpoint.fingerprint) }, ctx)
  check(ctx)
  const tunnel = await new Promise((resolve, reject) => proxy.forwardOut('127.0.0.1', 0, request.instanceId, 22, (error, stream) => error ? reject(error) : resolve(stream)))
  await ctx.defer(() => tunnel.destroy())
  // OCI's serviceHostKeyFingerprint authenticates the outer proxy, not the
  // per-instance console server. The inner connection travels exclusively over
  // that verified, encrypted proxy channel to the requested instance OCID.
  const client = await sshConnect({ sock: tunnel, username: request.instanceId, privateKey: keys.private }, ctx)
  return sshTerminal(client, ctx)
}

async function awsSerial(account, request, ctx) {
  const { default: AWS } = await import('aws-sdk')
  const { region = 'ap-southeast-1', accessKeyId, secretAccessKey, sessionToken } = account.credentials || {}
  const endpoint = awsSerialEndpoints[region]
  if (!endpoint) throw publicError('该 AWS 区域尚无已验证的串口端点，请更新端点配置后重试')
  const config = { region, credentials: { accessKeyId, secretAccessKey, sessionToken }, httpOptions: { timeout: 20000, connectTimeout: 10000 }, maxRetries: 1 }
  const ec2 = new AWS.EC2(config)
  const status = await ec2.getSerialConsoleAccessStatus({}).promise()
  check(ctx)
  if (!status.SerialConsoleAccessEnabled) throw publicError('此 AWS 账户尚未启用 EC2 Serial Console，请先由管理员启用；本模块不会自动修改账户策略')
  const keys = await keyPair()
  check(ctx)
  const response = await new AWS.EC2InstanceConnect(config).sendSerialConsoleSSHPublicKey({
    InstanceId: request.instanceId, SerialPort: 0, SSHPublicKey: keys.public
  }).promise()
  check(ctx)
  if (!response.Success) throw publicError('AWS 未接受临时串口公钥，请检查实例类型、运行状态及 IAM 权限')
  const client = await sshConnect({ host: endpoint.host, port: 22, username: `${request.instanceId}.port0`,
    // AWS publishes the RSA host-key fingerprint. Oracle negotiates the service's key type.
    algorithms: { serverHostKey: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] },
    privateKey: keys.private, hostVerifier: key => verifyFingerprint(key, endpoint.fingerprint) }, ctx)
  return sshTerminal(client, ctx)
}

export function azureEndpoint(value) {
  let url
  try { url = new URL(value) } catch { throw publicError('Azure 返回了无效的终端地址') }
  const allowed = /\.(?:serialconsole\.azure\.com|serialconsole\.azure\.net|serialconsole\.azurewebsites\.net)$/
  if (url.protocol !== 'wss:' || url.username || url.password || (url.port && url.port !== '443') || !allowed.test(url.hostname)) {
    throw publicError('Azure 返回的终端端点不在允许的官方域名内')
  }
  return url
}

async function azureRequest(url, token, { method = 'GET', body, signal } = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(20000) })
  if (!response.ok) {
    const error = publicError(`Azure 请求失败（HTTP ${response.status}），请检查账户授权及实例串口权限`)
    error.statusCode = response.status
    throw error
  }
  const text = await response.text()
  return text ? JSON.parse(text) : {}
}

async function remoteWebSocket(url, ctx, token) {
  check(ctx)
  const ws = new WebSocket(url, { handshakeTimeout: 20000, perMessageDeflate: false, maxPayload: 1024 * 1024,
    followRedirects: false })
  let opened = false
  const ready = new Promise((resolve, reject) => {
    let awaitingChallenge = true
    const authTimeout = setTimeout(() => reject(publicError('Azure 串口认证握手超时，请重试')), 20000)
    authTimeout.unref?.()
    ws.on('message', data => {
      if (awaitingChallenge) {
        // The Serial Console protocol requests the bearer token in its first
        // frame. Send it exactly once, never again as terminal input.
        awaitingChallenge = false
        ws.send(token)
        token = undefined
        clearTimeout(authTimeout)
        resolve()
        return
      }
      ctx.output(data)
    })
    ws.once('open', () => {
      opened = true
    })
    ws.on('error', error => { clearTimeout(authTimeout); if (!opened || awaitingChallenge) reject(error); else ctx.fail() })
    ws.on('close', () => { clearTimeout(authTimeout); if (!opened || awaitingChallenge) reject(new Error('WebSocket closed')); else ctx.end('云端终端已关闭') })
  })
  // Install listeners before yielding: a rejected handshake can arrive immediately.
  ready.catch(() => {})
  await ctx.defer(() => ws.terminate())
  check(ctx)
  await ready
  return { write: data => {
    if (ws.bufferedAmount > 262144) ctx.end('远端处理输入过慢')
    else ws.send(data, { binary: false })
  } }
}

async function azureSerial(account, request, ctx) {
  const credentials = normalizeAzureCredentials(account.credentials)
  const credential = new ClientSecretCredential(credentials.tenant, credentials.appId, credentials.password)
  const { token } = await credential.getToken('https://management.azure.com/.default', { abortSignal: ctx.signal })
  check(ctx)
  // request.instanceId is a validated ARM VM resource ID, never an arbitrary URL.
  const endpoint = `https://management.azure.com${request.instanceId}/providers/Microsoft.SerialConsole/serialPorts/0/connect?api-version=2024-07-01`
  const response = await azureRequest(endpoint, token, { method: 'POST', signal: ctx.signal })
  const url = azureEndpoint(response.connectionString)
  return remoteWebSocket(url, ctx, token)
}

export async function connectCloudTerminal(account, request, ctx) {
  check(ctx)
  try {
    if (request.mode === 'serial') {
      if (account.computeProvider === 'oracle') return await oracleSerial(account, request, ctx)
      if (account.computeProvider === 'aws') return await awsSerial(account, request, ctx)
      if (account.computeProvider === 'azure') return await azureSerial(account, request, ctx)
    }
    throw publicError('此平台的终端模式尚未接入')
  } catch (error) {
    if (ctx.signal.aborted || error.userMessage) throw error
    if (/verification failed|host denied/i.test(error.message || '')) throw publicError('云端 SSH 主机指纹校验失败，请检查官方指纹是否已轮换')
    if (error.level === 'client-authentication') throw publicError('云端串口 SSH 认证失败，请检查临时公钥或等待旧串口会话完全关闭后重试')
    const code = String(error.code || error.name || '')
    if (/AccessDenied|Unauthorized|Authentication|CredentialUnavailable/i.test(code)) throw publicError('云端认证或授权失败，请检查 API 凭据及串口访问权限')
    if (/EC2InstanceTypeInvalid|EC2InstanceStateInvalid|SerialConsoleAccessDisabled|SerialConsoleSessionLimitExceeded/.test(code)) {
      throw publicError(`AWS 串口连接受限（${code}），请检查支持的实例类型、运行状态及现有连接`)
    }
    throw error
  }
}
