import { Router } from 'express'
import { z } from 'zod'
import { createMcpToken, getMcpSettings, revokeMcpToken, saveMcpSettings } from '../utils/mcpAuth.mjs'

const router = Router()
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
router.get('/', (req, res) => res.json(getMcpSettings()))
router.put('/', async (req, res) => {
  try {
    const input = z.object({ enabled: z.boolean(), allowedOrigins: z.array(z.string().max(300)).max(20).default([]) }).strict().parse(req.body)
    await saveMcpSettings(input)
    res.json(getMcpSettings())
  } catch (error) { res.status(400).json({ error: error instanceof z.ZodError ? 'MCP 配置格式无效' : error.message }) }
})
router.post('/tokens', async (req, res) => {
  try {
    const input = z.object({ name: z.string().trim().min(1).max(80), mode: z.enum(['read', 'write']).default('read'),
      expiresInDays: z.number().int().min(1).max(365).default(90) }).strict().parse(req.body)
    res.status(201).json(await createMcpToken(input))
  } catch (error) { res.status(400).json({ error: error instanceof z.ZodError ? '令牌名称、权限或有效期无效' : error.message }) }
})
router.delete('/tokens/:id', async (req, res) => {
  try { await revokeMcpToken(req.params.id); res.json({ success: true }) }
  catch { res.status(500).json({ error: '撤销令牌失败，请重试' }) }
})
export default router
