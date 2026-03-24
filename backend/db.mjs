import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = join(__dirname, 'data')
mkdirSync(dataDir, { recursive: true })

/**
 * 计算账户 (Oracle / AWS / GCP / ...)
 * Schema: { id, name, computeProvider, enabled, credentials: {...} }
 */
const accountsFile = new JSONFile(join(dataDir, 'accounts.json'))
export const accountsDb = new Low(accountsFile, { accounts: [] })
await accountsDb.read()

/**
 * DNS 账户 (Cloudflare / Aliyun / ...)
 * Schema: { id, name, dnsProvider, enabled, credentials: {...} }
 */
const dnsAccountsFile = new JSONFile(join(dataDir, 'dns_accounts.json'))
export const dnsAccountsDb = new Low(dnsAccountsFile, { dnsAccounts: [] })
await dnsAccountsDb.read()

/**
 * 任务数据
 */
const tasksFile = new JSONFile(join(dataDir, 'tasks.json'))
export const tasksDb = new Low(tasksFile, { tasks: [] })
await tasksDb.read()

/**
 * 全局设置 (Telegram 等无 Provider 化的配置)
 */
const settingsFile = new JSONFile(join(dataDir, 'settings.json'))
export const settingsDb = new Low(settingsFile, {
  telegram: { botToken: '', chatId: '' },
  auth: {
    username: 'admin',
    passwordHash: '',
    passwordSalt: '',
    mustChangePassword: true,
    sessions: []
  }
})
await settingsDb.read()
