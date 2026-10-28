import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { accountsDb, dnsAccountsDb } from '../db.mjs'
import { getComputeProvider, getDnsProvider } from '../providers/registry.mjs'
import { getTasks, getTask, cancelTask } from '../queue.mjs'
import { serializeTask } from '../utils/taskCredentials.mjs'
import { findMcpToken } from '../utils/mcpAuth.mjs'
import { appendOperationLog } from '../utils/operationLog.mjs'
import { getPeriod, readAccountBilling } from '../routes/billing.mjs'
import { createCloudInstance } from './createCloudInstance.mjs'

const id = z.string().trim().min(1).max(2048)
const scope = { accountId: id, subscriptionId: id.optional().describe('Required for Azure instance operations; obtain from azure_subscriptions.') }
const instance = { ...scope, instanceId: id }
const sensitiveKey = /password|secret|token|credential|private.?key|access.?key|api.?key|authorization|user.?data|custom.?data/i

// Providers may include original SDK payloads and echoed credentials in errors.
function sanitizer(args) {
  const secrets = []
  function collect(value, sensitive = false) {
    if (typeof value === 'string' && sensitive && value) secrets.push(value)
    else if (Array.isArray(value)) value.forEach(item => collect(item, sensitive))
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) collect(item, sensitive || sensitiveKey.test(key))
    }
  }
  collect(args)
  for (const account of [...accountsDb.data.accounts, ...dnsAccountsDb.data.dnsAccounts]) {
    collect(account.credentials)
    collect({ privateKeyText: account.privateKeyText })
  }
  const sorted = [...new Set(secrets)].sort((a, b) => b.length - a.length)
  function clean(value) {
    if (typeof value === 'string') return sorted.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'raw' && !sensitiveKey.test(key)).map(([key, item]) => [key, clean(item)]))
    return value
  }
  return clean
}

function accountById(accountId, dns = false) {
  const accounts = dns ? dnsAccountsDb.data.dnsAccounts : accountsDb.data.accounts
  const account = accounts.find(item => item.id === accountId && item.enabled !== false)
  if (!account) throw new Error('启用的账户不存在')
  return account
}

function compute(args, azureOnly = false) {
  const account = accountById(args.accountId)
  if (azureOnly && account.computeProvider !== 'azure') throw new Error('此工具仅支持 Azure 账户')
  const provider = getComputeProvider(account)
  if (account.computeProvider === 'azure') {
    if (!args.subscriptionId) throw new Error('Azure 操作需要 subscriptionId，请先查询 azure_subscriptions')
    provider.useSubscription(args.subscriptionId)
    // Prevent an instance resource ID from silently selecting another subscription.
    if (args.instanceId && !args.instanceId.toLowerCase().startsWith(`/subscriptions/${args.subscriptionId.toLowerCase()}/`)) {
      throw new Error('实例 ID 与所选订阅不匹配')
    }
  }
  return provider
}

function visibleTask(task) {
  if (!task) throw new Error('任务不存在')
  accountById(task.accountId)
  const { id, accountId, type, status, result, error, retries, createdAt, updatedAt } = serializeTask(task)
  return { id, accountId, type, status, result, error, retries, createdAt, updatedAt }
}

export function createMcpServer(req, token) {
  const server = new McpServer({ name: 'cloud-manager', version: '1.0.0' })
  function register(name, description, shape, write, handler, destructive = false) {
    if (write && token.mode !== 'write') return
    server.registerTool(name, { description, inputSchema: z.object(shape).strict(), annotations: {
      readOnlyHint: !write, destructiveHint: destructive, idempotentHint: !write, openWorldHint: true
    } }, async args => {
      const started = Date.now()
      const clean = sanitizer(args)
      let result
      let error = ''
      try {
        // Recheck expiry, service state and revocation immediately before execution.
        const current = findMcpToken(req.headers.authorization)
        if (!current || current.id !== token.id || (write && current.mode !== 'write')) throw new Error('MCP 令牌已失效或权限不足')
        result = clean(await handler(args))
        if (result?.status === 'error') error = result.error || '查询失败'
      } catch (cause) {
        error = clean(cause.message || '工具执行失败')
        result = { error }
      }
      try {
        await appendOperationLog({ operator: `MCP: ${token.name}`, method: 'POST', path: '/mcp', action: name,
          resource: 'MCP', target: clean(args.instanceId || args.taskId || args.accountId || args.dnsAccountId || ''),
          metadata: { mcpTokenId: token.id, permission: token.mode }, result: error ? 'failed' : 'success',
          statusCode: error ? 400 : 200, durationMs: Date.now() - started, ip: req.ip || '', error })
      } catch { console.error('Failed to persist MCP operation log') }
      return { content: [{ type: 'text', text: JSON.stringify(result ?? { success: true }) }], ...(error ? { isError: true } : {}) }
    })
  }

  register('list_accounts', 'List enabled compute and DNS accounts, without credentials.', {}, false, () => ({
    compute: accountsDb.data.accounts.filter(a => a.enabled !== false).map(({ id, name, computeProvider }) => ({ id, name, provider: computeProvider })),
    dns: dnsAccountsDb.data.dnsAccounts.filter(a => a.enabled !== false).map(({ id, name, dnsProvider }) => ({ id, name, provider: dnsProvider }))
  }))
  register('list_instances', 'List instances for an account and Azure subscription.', scope, false, args => compute(args).listInstances())
  register('get_instance', 'Read instance details without raw SDK data.', instance, false, args => compute(args).getInstance(args.instanceId))
  register('azure_subscriptions', 'List eligible Azure subscriptions.', { accountId: id }, false, args => {
    const account = accountById(args.accountId)
    if (account.computeProvider !== 'azure') throw new Error('此工具仅支持 Azure 账户')
    return getComputeProvider(account).listEligibleSubscriptions()
  })
  register('azure_create_options', 'Read available free creation options and quota evidence. Quota is not remaining free hours; billing evidence does not guarantee future free usage.',
    { accountId: id, subscriptionId: id }, false, args => compute(args, true).listCreateOptions(args.subscriptionId))
  register('get_billing', 'Read account billing. Defaults to current UTC month; to is exclusive. Includes all eligible subscriptions.',
    { accountId: id, month: z.string().regex(/^\d{4}-\d{2}$/).optional(), from: z.string().optional(), to: z.string().optional(), refresh: z.boolean().default(false) },
    false, args => readAccountBilling(accountById(args.accountId), getPeriod(args), args.refresh))
  register('list_tasks', 'Read up to 200 recent tasks for enabled accounts. Creation credentials are excluded.',
    { accountId: id.optional(), status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']).optional() }, false,
    args => getTasks(args).filter(t => accountsDb.data.accounts.some(a => a.id === t.accountId && a.enabled !== false)).map(visibleTask))
  register('get_task', 'Read creation task progress; never returns creation passwords.', { taskId: id }, false, args => visibleTask(getTask(args.taskId)))
  register('list_dns_records', 'List DNS records.', { dnsAccountId: id, name: id.optional(), type: id.optional() }, false,
    ({ dnsAccountId, ...query }) => getDnsProvider(accountById(dnsAccountId, true)).listRecords(query))

  register('create_instance', 'Queue instance creation using existing validations. Azure defaults to checked free VM/disk options and private networking; public IPv4 is chargeable. Oracle/AWS use existing provider defaults and may incur charges. Poll get_task; do not retry blindly after a timeout.', {
    ...scope, delay: z.number().int().min(1).max(3600).default(60),
    location: id.optional(), vmSize: id.optional(), adminUsername: z.string().max(64).optional(), adminPassword: z.string().min(1).max(256).optional(),
    createPublicIp: z.boolean().default(false), rootPassword: z.string().min(1).max(256).optional(),
    shape: id.optional(), ocpus: z.number().positive().max(128).optional(), memoryGb: z.number().positive().max(2048).optional(),
    instanceType: id.optional(), imageId: id.optional()
  }, true, ({ accountId, ...params }) => createCloudInstance(accountById(accountId), params))
  register('instance_action', 'Start, stop or reboot an instance. Starting may incur charges.',
    { ...instance, action: z.enum(['START', 'STOP', 'REBOOT', 'HARD_REBOOT']) }, true,
    args => compute(args).instanceAction(args.instanceId, args.action), true)
  register('delete_instance', 'Permanently delete/terminate an instance. Disks or IPs may remain billable according to provider behavior.',
    instance, true, args => compute(args).deleteInstance(args.instanceId), true)
  register('upsert_dns_record', 'Create or update a DNS record.', {
    dnsAccountId: id, name: id, content: z.string().min(1).max(8192), type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA']).default('A'),
    options: z.object({ ttl: z.number().int().min(1).optional(), proxied: z.boolean().optional() }).strict().default({})
  }, true, args => getDnsProvider(accountById(args.dnsAccountId, true)).upsertRecord(args.name, args.content, args.type, args.options), true)
  register('delete_dns_record', 'Delete DNS records matching name and type.', { dnsAccountId: id, name: id, type: id.default('A') }, true,
    args => getDnsProvider(accountById(args.dnsAccountId, true)).deleteRecord(args.name, args.type), true)
  register('cancel_task', 'Cancel a pending/running task. Cloud operations already submitted may still complete.', { taskId: id }, true, async args => {
    const task = getTask(args.taskId)
    visibleTask(task)
    if (!['pending', 'running'].includes(task.status)) throw new Error('只能取消待执行或运行中的任务')
    return visibleTask(await cancelTask(args.taskId))
  }, true)
  return server
}
