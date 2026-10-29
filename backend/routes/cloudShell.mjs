import { Router } from 'express'
import { accountsDb } from '../db.mjs'
import { terminalCapabilities, terminalSessions } from '../services/terminalSessions.mjs'

const router = Router()

// Return only account context and capabilities, never credentials.
function oracleContext(account) {
  const credentials = account.credentials || {}
  const selectedProfile = credentials.profile || credentials.configProfile || account.configProfile || 'DEFAULT'
  const context = {}
  let profile = ''
  for (const raw of String(credentials.configText || account.configText || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = line.match(/^\[(.*)\]$/)
    if (section) { profile = section[1].trim(); continue }
    if (profile !== selectedProfile) continue
    const match = line.match(/^(region|tenancy)\s*=\s*(.*)$/)
    if (match) context[match[1]] = match[2].trim()
  }
  return context
}

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store')
  const accounts = accountsDb.data.accounts.filter(account => account.enabled !== false).map(account => {
    const credentials = account.credentials || {}
    const oracle = account.computeProvider === 'oracle' ? oracleContext(account) : {}
    return {
      id: account.id,
      name: account.name,
      provider: account.computeProvider,
      capabilities: terminalCapabilities(account.computeProvider),
      region: account.computeProvider === 'aws' ? String(credentials.region || 'ap-southeast-1') : oracle.region || '',
      tenant: account.computeProvider === 'azure' ? String(credentials.tenant || credentials.tenantId || '') : oracle.tenancy || ''
    }
  })
  res.json({ accounts })
})

router.post('/sessions', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  try {
    await terminalSessions.waitForCleanup(req.authToken, req.body)
    res.status(201).json(terminalSessions.reserve(req.authToken, req.body))
  }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '终端会话创建失败' }) }
})

router.delete('/sessions/:id', (req, res) => {
  try { terminalSessions.cancel(req.params.id, req.authToken); res.json({ success: true }) }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '终端会话关闭失败' }) }
})

export default router
