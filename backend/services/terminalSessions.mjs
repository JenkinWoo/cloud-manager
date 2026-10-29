import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { accountsDb } from '../db.mjs'
import { findSession } from '../utils/auth.mjs'

export function terminalCapabilities(provider) {
  return { serial: ['oracle', 'aws', 'azure'].includes(provider) }
}

export function terminalSize(cols, rows) {
  return { cols: Math.max(20, Math.min(300, Number.isInteger(cols) ? cols : 100)),
    rows: Math.max(5, Math.min(120, Number.isInteger(rows) ? rows : 30)) }
}

function failure(message, status = 400) { return Object.assign(new Error(message), { status }) }

export class TerminalSessions {
  constructor({ getAccount, isAuthenticated, connect, now = Date.now, limits = {}, onCleanupError = console.error }) {
    this.getAccount = getAccount
    this.isAuthenticated = isAuthenticated
    this.connect = connect
    this.now = now
    this.onCleanupError = onCleanupError
    this.limits = { pending: 60000, startup: 600000, idle: 900000, lifetime: 3600000, ...limits }
    this.sessions = new Map()
  }

  reserve(token, body = {}) {
    if (!this.isAuthenticated(token)) throw failure('登录状态已失效', 401)
    const account = this.getAccount(body.accountId)
    if (!account || account.enabled === false) throw failure('计算账户不存在或已禁用', 404)
    const capabilities = terminalCapabilities(account.computeProvider)
    if (body.mode !== 'serial' || !capabilities.serial) {
      throw failure('该平台尚未接入此类终端，请选择实例救援终端', 400)
    }
    const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : ''
    if (body.mode === 'serial') {
      const valid = account.computeProvider === 'oracle' ? /^ocid1\.instance\.[a-z0-9.-]+$/i.test(instanceId)
        : account.computeProvider === 'aws' ? /^i-[a-f0-9]{8,17}$/.test(instanceId)
          : /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[^/\s?#%]+\/providers\/Microsoft\.Compute\/virtualMachines\/[^/\s?#%]+$/i.test(instanceId)
      if (!valid) throw failure({
        oracle: '请输入有效的 Oracle 实例 OCID',
        aws: '请输入有效的 AWS 实例 ID',
        azure: '请输入有效的 Azure 完整虚拟机资源 ID'
      }[account.computeProvider])
    }
    const entries = [...this.sessions.values()]
    if (entries.length >= 12 || entries.filter(s => s.token === token).length >= 4) throw failure('终端会话数量已达上限，请先断开其他会话', 429)
    if (body.mode === 'serial' && entries.some(s => s.accountId === account.id && s.instanceId === instanceId)) {
      throw failure('该实例已有连接或正在清理连接，请先断开并稍后重试', 409)
    }
    const session = {
      id: randomUUID(), token, accountId: account.id, mode: body.mode, instanceId,
      size: terminalSize(body.cols, body.rows), createdAt: this.now(), lastInput: this.now(),
      state: 'pending', controller: new AbortController(), cleanups: [], running: null, transport: null, socket: null
    }
    this.sessions.set(session.id, session)
    return { id: session.id }
  }

  send(session, message) {
    if (session.socket?.readyState !== 1) return
    if (session.socket.bufferedAmount > 1024 * 1024) { this.stop(session, '终端输出过快，连接已关闭'); return }
    session.socket.send(JSON.stringify(message))
  }

  async cleanup(session, fn) {
    try { await fn() } catch {
      // Never log tokens, keys, typed commands, or provider URLs.
      this.onCleanupError(`[terminal] ${session.id}: remote cleanup failed; account=${session.accountId}, instance=${session.instanceId}`)
      this.send(session, { type: 'notice', message: '远端连接清理失败，请在云平台检查残留的控制台连接。' })
    }
  }

  stop(session, message = '连接已断开') {
    if (!session || session.state === 'closed') return
    session.state = 'closed'
    session.controller.abort()
    this.send(session, { type: 'closed', message })
    session.socket?.close(1000)
    // Keep the resource lock until in-flight creation and cleanup have finished.
    session.cleanupPromise = (async () => {
      for (const fn of session.cleanups.splice(0).reverse()) await this.cleanup(session, fn)
      await session.running?.catch(() => {})
      this.sessions.delete(session.id)
    })()
  }

  cancel(id, token) {
    const session = this.sessions.get(id)
    if (!session || session.token !== token) throw failure('终端会话不存在', 404)
    this.stop(session)
    return session.cleanupPromise
  }

  async waitForCleanup(token, body = {}) {
    if (!this.isAuthenticated(token)) throw failure('登录状态已失效', 401)
    const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : ''
    const pending = [...this.sessions.values()].filter(s => s.token === token &&
      s.accountId === body.accountId && s.instanceId === instanceId && s.state === 'closed')
    await Promise.all(pending.map(s => s.cleanupPromise))
  }

  attach(socket) {
    let session
    let authenticating = false
    let inputBytes = 0
    let windowStart = this.now()
    let alive = true
    const authTimer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 10000)
    authTimer.unref?.()
    socket.on('pong', () => { alive = true })
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return }
      alive = false
      socket.ping()
    }, 15000)
    heartbeat.unref?.()
    const finish = () => { clearTimeout(authTimer); clearInterval(heartbeat); this.stop(session) }
    socket.on('close', finish)
    socket.on('error', finish)
    socket.on('message', (raw, binary) => {
      try {
        if (binary || raw.length > 65536) throw failure('无效的终端消息')
        const message = JSON.parse(raw.toString())
        if (!session) {
          if (authenticating || message.type !== 'auth' || !this.isAuthenticated(message.token)) throw failure('登录状态已失效')
          authenticating = true
          const candidate = this.sessions.get(message.sessionId)
          if (!candidate || candidate.token !== message.token || candidate.state !== 'pending') throw failure('终端会话不存在或已使用')
          const account = this.getAccount(candidate.accountId)
          if (!account || account.enabled === false) throw failure('账户已禁用或删除')
          session = candidate
          session.socket = socket
          session.state = 'connecting'
          clearTimeout(authTimer)
          this.send(session, { type: 'status', message: '正在建立云端连接…' })
          const context = {
            signal: session.controller.signal,
            size: session.size,
            defer: async fn => {
              if (session.state === 'closed') await this.cleanup(session, fn)
              else session.cleanups.push(fn)
            },
            status: message => this.send(session, { type: 'status', message }),
            output: data => this.send(session, { type: 'output', data: Buffer.from(data).toString('base64') }),
            end: message => this.stop(session, message),
            fail: () => this.stop(session, '云端连接中断，请重新连接')
          }
          session.running = Promise.resolve().then(async () => {
            try {
              const transport = await this.connect(account, { mode: session.mode, instanceId: session.instanceId }, context)
              if (session.state === 'closed') return
              session.transport = transport
              session.state = 'connected'
              session.lastInput = this.now()
              this.send(session, { type: 'ready', message: '已连接' })
            } catch (error) {
              if (session.state !== 'closed') {
                // Adapters expose only intentional, sanitized user-facing errors.
                const message = error.userMessage || '连接失败，请检查云账户权限、实例状态及后端网络。'
                this.send(session, { type: 'error', message })
                this.stop(session, message)
              }
            }
          })
          return
        }
        if (!this.isAuthenticated(session.token) || this.getAccount(session.accountId)?.enabled === false || !this.getAccount(session.accountId)) {
          this.stop(session, '登录已失效或账户已禁用'); return
        }
        if (session.state !== 'connected') return
        if (this.now() - windowStart > 1000) { inputBytes = 0; windowStart = this.now() }
        inputBytes += raw.length
        if (inputBytes > 262144) throw failure('输入过快')
        if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 16384) {
          session.lastInput = this.now()
          session.transport.write(message.data)
        } else if (message.type === 'resize') {
          session.size = terminalSize(message.cols, message.rows)
          Promise.resolve(session.transport.resize?.(session.size)).catch(() => this.send(session, { type: 'notice', message: '远端终端尺寸更新失败' }))
        } else throw failure('无效的终端操作')
      } catch {
        if (session) this.stop(session, '终端请求无效或登录已失效')
        else socket.close(1008, 'Invalid terminal session')
      }
    })
  }

  sweep() {
    for (const s of this.sessions.values()) {
      if (s.state === 'closed') continue
      const age = this.now() - s.createdAt
      if (!this.isAuthenticated(s.token) || !this.getAccount(s.accountId) || this.getAccount(s.accountId).enabled === false) this.stop(s, '登录已失效或账户已禁用')
      else if (age > this.limits.lifetime || (s.state === 'connected' && this.now() - s.lastInput > this.limits.idle)) this.stop(s, '会话已到期，请重新连接')
      else if (s.state === 'pending' && age > this.limits.pending) this.stop(s, '连接请求已过期')
      else if (s.state === 'connecting' && age > this.limits.startup) this.stop(s, '云端连接超时，请重试')
    }
  }
}

export const terminalSessions = new TerminalSessions({
  getAccount: id => accountsDb.data.accounts.find(account => account.id === id),
  isAuthenticated: token => typeof token === 'string' && Boolean(findSession(token)),
  connect: async (...args) => (await import('./cloudTerminalProviders.mjs')).connectCloudTerminal(...args)
})

export function installTerminalWebSocket(server, sessions = terminalSessions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/cloud-shell/socket') { socket.destroy(); return }
    try {
      const origin = new URL(request.headers.origin)
      const extras = (process.env.CLOUD_SHELL_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
      if (!['http:', 'https:'].includes(origin.protocol) || (origin.host !== request.headers.host && !extras.includes(origin.origin))) throw new Error()
    } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, ws => sessions.attach(ws))
  })
  const timer = setInterval(() => sessions.sweep(), 15000)
  timer.unref()
  server.on('close', () => { clearInterval(timer); wss.close(); for (const s of sessions.sessions.values()) sessions.stop(s) })
  return async () => {
    for (const s of sessions.sessions.values()) sessions.stop(s, '服务正在关闭')
    await Promise.allSettled([...sessions.sessions.values()].map(s => s.cleanupPromise))
  }
}
