import { Router } from 'express'
import { cleanupOperationLogsBeforeDays, getOperationLog, getOperationLogs } from '../utils/operationLog.mjs'

const router = Router()

router.get('/', (req, res) => {
  const { result, resource, keyword, limit } = req.query
  res.json(getOperationLogs({ result, resource, keyword, limit }))
})

router.get('/:id', (req, res) => {
  const log = getOperationLog(req.params.id)
  if (!log) return res.status(404).json({ error: '日志不存在或已被清理' })
  res.json(log)
})

router.post('/cleanup', async (req, res) => {
  try {
    const olderThanDays = Number(req.body?.olderThanDays ?? req.body?.days)
    if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
      return res.status(400).json({ error: '清理天数必须是 1 到 3650 之间的整数' })
    }

    res.json({
      success: true,
      ...(await cleanupOperationLogsBeforeDays(olderThanDays))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
