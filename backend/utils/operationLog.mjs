import { v4 as uuidv4 } from 'uuid'
import { accountsDb, operationLogsDb, settingsDb } from '../db.mjs'

const MAX_LOGS = Number(process.env.OPERATION_LOG_MAX || 1000)
const DEFAULT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
let writeChain = Promise.resolve()
const INSTANCE_ACTION_LABELS = {
  START: '启动',
  STOP: '停止',
  REBOOT: '重启',
  HARD_REBOOT: '强制重启'
}

function getRequestPath(req) {
  try {
    return new URL(req.originalUrl || req.url || '', 'http://localhost').pathname
  } catch (_) {
    return req.path || req.url || ''
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor) {
    return forwardedFor.split(',')[0].trim()
  }

  return req.ip || req.socket?.remoteAddress || ''
}

function getOperator(req) {
  if (req.authUser?.username) return req.authUser.username
  if (typeof req.body?.username === 'string' && req.body.username.trim()) return req.body.username.trim()
  return 'anonymous'
}

function decodeLogTarget(req) {
  const raw = req.headers['x-operation-target']
  if (typeof raw !== 'string' || !raw) return {}

  try {
    return JSON.parse(decodeURIComponent(raw))
  } catch (_) {
    return {}
  }
}

function getAccountName(accountId) {
  return accountsDb.data.accounts.find((item) => item.id === accountId)?.name || '未知账户'
}

function joinTarget(parts) {
  return parts.filter(Boolean).join(' / ') || '—'
}

function normalizeRetentionDays(value) {
  const days = Number(value)
  if (!Number.isInteger(days) || days < 1) return DEFAULT_RETENTION_DAYS
  return Math.min(days, 3650)
}

export function getOperationLogSettings() {
  return {
    retentionDays: normalizeRetentionDays(settingsDb.data.operationLogs?.retentionDays)
  }
}

function pruneLogsByRetention(logs, now = Date.now()) {
  const { retentionDays } = getOperationLogSettings()
  const cutoff = now - retentionDays * DAY_MS

  return logs.filter((log) => {
    const createdAt = Date.parse(log.createdAt || '')
    return !Number.isFinite(createdAt) || createdAt >= cutoff
  })
}

function cloudTargetFromPath(path, body = {}, logTarget = {}) {
  const parts = path.split('/').filter(Boolean)
  const accountId = parts[2]
  const accountName = logTarget.accountName || getAccountName(accountId)
  const targetName = logTarget.instanceName || logTarget.volumeName || logTarget.targetName || body.displayName || ''

  if (/^\/api\/cloud\/[^/]+\/instances$/.test(path)) {
    return joinTarget([accountName, targetName || '新建实例'])
  }

  if (/^\/api\/cloud\/[^/]+\/instances\/[^/]+/.test(path)) {
    return joinTarget([accountName, targetName || '未记录实例名称'])
  }

  if (/^\/api\/cloud\/[^/]+\/volumes\/[^/]+/.test(path)) {
    return joinTarget([accountName, targetName || '未记录引导卷名称'])
  }

  return accountName
}

function actionLabel(method, path, body = {}) {
  if (method === 'POST' && path === '/api/auth/login') return '登录系统'
  if (method === 'POST' && path === '/api/auth/logout') return '退出登录'
  if (method === 'POST' && path === '/api/auth/update-account') return '更新账户安全'
  if (method === 'POST' && path === '/api/logs/cleanup') return '手动清理系统日志'

  if (method === 'PUT' && path === '/api/settings/telegram') return '更新通知配置'
  if (method === 'PUT' && path === '/api/settings/operation-logs') return '更新系统日志规则'

  if (method === 'POST' && path === '/api/accounts') return '新建云账户'
  if (method === 'PUT' && /^\/api\/accounts\/[^/]+$/.test(path)) return '更新云账户'
  if (method === 'DELETE' && /^\/api\/accounts\/[^/]+$/.test(path)) return '删除云账户'
  if (method === 'POST' && /^\/api\/accounts\/[^/]+\/test$/.test(path)) return '测试云账户连接'

  if (method === 'POST' && path === '/api/accounts/dns') return '新建域名解析账户'
  if (method === 'PUT' && /^\/api\/accounts\/dns\/[^/]+$/.test(path)) return '更新域名解析账户'
  if (method === 'DELETE' && /^\/api\/accounts\/dns\/[^/]+$/.test(path)) return '删除域名解析账户'
  if (method === 'POST' && /^\/api\/accounts\/dns\/[^/]+\/test$/.test(path)) return '测试域名解析账户连接'

  if (method === 'POST' && /^\/api\/dns\/[^/]+\/records$/.test(path)) return '保存域名解析记录'
  if (method === 'DELETE' && /^\/api\/dns\/[^/]+\/records$/.test(path)) return '删除域名解析记录'

  if (method === 'POST' && /^\/api\/cloud\/[^/]+\/instances$/.test(path)) return '创建云实例任务'
  if (method === 'POST' && /^\/api\/cloud\/[^/]+\/instances\/[^/]+\/action$/.test(path)) {
    return `执行实例${INSTANCE_ACTION_LABELS[body.action] || ''}操作`
  }
  if (method === 'DELETE' && /^\/api\/cloud\/[^/]+\/instances\/[^/]+$/.test(path)) return '删除云实例'
  if (method === 'POST' && /^\/api\/cloud\/[^/]+\/instances\/[^/]+\/switch-ip$/.test(path)) return '切换实例公网地址'
  if (method === 'POST' && /^\/api\/cloud\/[^/]+\/instances\/[^/]+\/add-ipv6$/.test(path)) return '添加实例第六版公网地址'
  if (method === 'PUT' && /^\/api\/cloud\/[^/]+\/instances\/[^/]+\/shape$/.test(path)) return '修改实例配置'
  if (method === 'POST' && /^\/api\/cloud\/[^/]+\/instances\/[^/]+\/firewall\/allow-all$/.test(path)) return '放开实例防火墙'
  if (method === 'POST' && /^\/api\/cloud\/[^/]+\/elastic-ips\/release-unused$/.test(path)) return '释放空闲弹性公网地址'
  if (method === 'PUT' && /^\/api\/cloud\/[^/]+\/volumes\/[^/]+\/size$/.test(path)) return '修改引导卷大小'
  if (method === 'DELETE' && /^\/api\/cloud\/[^/]+\/volumes\/[^/]+$/.test(path)) return '删除引导卷'
  if (method === 'POST' && /^\/api\/cloud\/[^/]+\/network\/setup$/.test(path)) return '创建云网络'

  if (method === 'DELETE' && /^\/api\/tasks\/[^/]+$/.test(path)) return '取消任务'

  return '系统操作'
}

function resourceLabel(path) {
  if (path.startsWith('/api/auth')) return '认证'
  if (path.startsWith('/api/logs')) return '系统日志'
  if (path.startsWith('/api/settings')) return '系统设置'
  if (path.startsWith('/api/accounts/dns')) return '域名解析账户'
  if (path.startsWith('/api/accounts')) return '云账户'
  if (path.startsWith('/api/dns')) return '域名解析管理'
  if (path.startsWith('/api/cloud')) return '云资源'
  if (path.startsWith('/api/tasks')) return '任务队列'
  return '系统'
}

function targetFromPath(path, body = {}, logTarget = {}) {
  const parts = path.split('/').filter(Boolean)

  if (path === '/api/accounts' && body.name) return body.name
  if (path === '/api/accounts/dns' && body.name) return body.name
  if (path.includes('/records') && body.name) return body.name

  if (parts[1] === 'cloud') {
    return cloudTargetFromPath(path, body, logTarget)
  }

  if (path === '/api/logs/cleanup') {
    return `${body.olderThanDays || body.days || 0} 天前日志`
  }

  return parts.at(-1) || ''
}

function normalizeAction(action = '') {
  return String(action || '')
    .replace(/执行实例操作:\s*START/g, '执行实例启动操作')
    .replace(/执行实例操作:\s*STOP/g, '执行实例停止操作')
    .replace(/执行实例操作:\s*REBOOT/g, '执行实例重启操作')
    .replace(/执行实例操作:\s*HARD_REBOOT/g, '执行实例强制重启操作')
    .replace(/Telegram/g, '通知')
    .replace(/DNS/g, '域名解析')
    .replace(/IPv6/g, '第六版公网地址')
    .replace(/\bIP\b/g, '公网地址')
}

function normalizeResource(resource = '') {
  if (resource === 'DNS 账户') return '域名解析账户'
  if (resource === 'DNS 管理') return '域名解析管理'
  return resource || '系统'
}

function looksLikeTechnicalId(value = '') {
  const text = String(value || '')
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text) ||
    /^ocid1\./i.test(text) ||
    (text.length > 24 && /^[a-z0-9._:-]+$/i.test(text))
}

function normalizeTarget(log) {
  if (log.path?.startsWith('/api/cloud/')) {
    if (!log.target || looksLikeTechnicalId(log.target)) {
      return cloudTargetFromPath(log.path, {}, log.metadata || {})
    }
  }

  return log.target
}

function normalizeLogForResponse(log) {
  return {
    ...log,
    action: normalizeAction(log.action),
    resource: normalizeResource(log.resource),
    target: normalizeTarget(log)
  }
}

function shouldLog(req) {
  const method = req.method.toUpperCase()
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false

  const path = getRequestPath(req)
  if (!path.startsWith('/api/')) return false
  if (method === 'GET' && path.startsWith('/api/logs')) return false

  return true
}

export function getOperationLogs(filter = {}) {
  let logs = (operationLogsDb.data.logs || []).map(normalizeLogForResponse)

  if (filter.result) logs = logs.filter((item) => item.result === filter.result)
  if (filter.resource) logs = logs.filter((item) => item.resource === filter.resource)
  if (filter.keyword) {
    const keyword = String(filter.keyword).trim().toLowerCase()
    if (keyword) {
      logs = logs.filter((item) =>
        [item.operator, item.action, item.resource, item.target, item.path, item.error]
          .some((value) => String(value || '').toLowerCase().includes(keyword))
      )
    }
  }

  const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), 500)
  return logs.slice().reverse().slice(0, limit)
}

export function appendOperationLog(entry) {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      operationLogsDb.data.logs ||= []
      operationLogsDb.data.logs.push({
        id: uuidv4(),
        createdAt: new Date().toISOString(),
        ...entry
      })

      operationLogsDb.data.logs = pruneLogsByRetention(operationLogsDb.data.logs)

      if (operationLogsDb.data.logs.length > MAX_LOGS) {
        operationLogsDb.data.logs = operationLogsDb.data.logs.slice(-MAX_LOGS)
      }

      await operationLogsDb.write()
    })

  return writeChain
}

export function cleanupExpiredOperationLogs() {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      operationLogsDb.data.logs ||= []
      const before = operationLogsDb.data.logs.length
      operationLogsDb.data.logs = pruneLogsByRetention(operationLogsDb.data.logs)
      await operationLogsDb.write()

      return {
        deleted: before - operationLogsDb.data.logs.length,
        ...getOperationLogSettings()
      }
    })

  return writeChain
}

export function cleanupOperationLogsBeforeDays(olderThanDays) {
  const days = Number(olderThanDays)
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('清理天数必须是 1 到 3650 之间的整数')
  }

  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      operationLogsDb.data.logs ||= []
      const cutoff = Date.now() - days * DAY_MS
      const before = operationLogsDb.data.logs.length

      operationLogsDb.data.logs = operationLogsDb.data.logs.filter((log) => {
        const createdAt = Date.parse(log.createdAt || '')
        return !Number.isFinite(createdAt) || createdAt >= cutoff
      })

      await operationLogsDb.write()

      return {
        deleted: before - operationLogsDb.data.logs.length,
        olderThanDays: days
      }
    })

  return writeChain
}

export function operationLogMiddleware(req, res, next) {
  if (!shouldLog(req)) return next()

  const startedAt = Date.now()
  const method = req.method.toUpperCase()
  const path = getRequestPath(req)
  const headerLogTarget = decodeLogTarget(req)
  let responsePayload = null
  const originalJson = res.json.bind(res)

  res.json = (body) => {
    responsePayload = body
    return originalJson(body)
  }

  res.on('finish', () => {
    const statusCode = res.statusCode
    const logTarget = {
      ...headerLogTarget,
      ...(req.operationLogTarget || {})
    }

    void appendOperationLog({
      operator: getOperator(req),
      method,
      path,
      action: actionLabel(method, path, req.body),
      resource: resourceLabel(path),
      target: targetFromPath(path, req.body, logTarget),
      metadata: logTarget,
      result: statusCode >= 400 ? 'failed' : 'success',
      statusCode,
      durationMs: Date.now() - startedAt,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      error: statusCode >= 400 ? responsePayload?.error || res.statusMessage || '' : ''
    }).catch((err) => {
      console.error('Failed to write operation log:', err.message)
    })
  })

  next()
}
