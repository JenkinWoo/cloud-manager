import { Router } from 'express'
import { settingsDb } from '../db.mjs'
import { cleanupExpiredOperationLogs, getOperationLogSettings } from '../utils/operationLog.mjs'

const router = Router()

router.get('/', (req, res) => {
  const settings = settingsDb.data || {}
  res.json({
    telegram: settings.telegram || {},
    operationLogs: getOperationLogSettings()
  })
})

router.put('/telegram', async (req, res) => {
  try {
    settingsDb.data.telegram = { ...settingsDb.data.telegram, ...req.body }
    await settingsDb.write()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/operation-logs', async (req, res) => {
  try {
    const retentionDays = Number(req.body?.retentionDays)
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      return res.status(400).json({ error: '日志保留天数必须是 1 到 3650 之间的整数' })
    }

    settingsDb.data.operationLogs = {
      ...(settingsDb.data.operationLogs || {}),
      retentionDays
    }
    await settingsDb.write()

    const cleanupResult = await cleanupExpiredOperationLogs()
    res.json({ success: true, ...cleanupResult })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
