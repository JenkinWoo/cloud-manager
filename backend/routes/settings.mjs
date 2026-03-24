import { Router } from 'express'
import { settingsDb } from '../db.mjs'

const router = Router()

router.get('/', (req, res) => {
  const settings = settingsDb.data || {}
  res.json({
    telegram: settings.telegram || {}
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

export default router
