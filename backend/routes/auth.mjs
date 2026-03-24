import { Router } from 'express'
import { settingsDb } from '../db.mjs'
import {
  ensureAuthConfig,
  findSession,
  hashPassword,
  issueSession,
  revokeAllSessions,
  revokeSession,
  sanitizeAuthSettings,
  verifyPassword
} from '../utils/auth.mjs'

const router = Router()

function getBearerToken(req) {
  const authorization = req.headers.authorization || ''
  if (authorization.startsWith('Bearer ')) {
    return authorization.slice(7)
  }

  if (typeof req.query.token === 'string' && req.query.token) {
    return req.query.token
  }

  return null
}

export async function authRequired(req, res, next) {
  await ensureAuthConfig()

  const token = getBearerToken(req)
  if (!token) return res.status(401).json({ error: '未登录' })

  const session = findSession(token)
  if (!session) return res.status(401).json({ error: '登录状态已失效' })

  session.lastUsedAt = new Date().toISOString()
  await settingsDb.write()

  req.authToken = token
  req.authUser = sanitizeAuthSettings()
  next()
}

router.get('/status', async (req, res) => {
  await ensureAuthConfig()

  const token = getBearerToken(req)
  const session = token ? findSession(token) : null
  if (!session) {
    return res.json({
      authenticated: false,
      ...sanitizeAuthSettings()
    })
  }

  session.lastUsedAt = new Date().toISOString()
  await settingsDb.write()

  res.json({
    authenticated: true,
    ...sanitizeAuthSettings()
  })
})

router.post('/login', async (req, res) => {
  await ensureAuthConfig()

  const { username = '', password = '' } = req.body || {}
  const auth = settingsDb.data.auth

  if (username !== auth.username) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const ok = await verifyPassword(password, auth.passwordSalt, auth.passwordHash)
  if (!ok) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const token = issueSession()
  await settingsDb.write()

  res.json({
    token,
    user: sanitizeAuthSettings()
  })
})

router.post('/logout', authRequired, async (req, res) => {
  await revokeSession(req.authToken)
  res.json({ success: true })
})

router.post('/update-account', authRequired, async (req, res) => {
  const { currentPassword = '', newUsername = '', newPassword = '' } = req.body || {}
  const auth = settingsDb.data.auth
  const username = String(newUsername).trim()
  const password = String(newPassword)
  const usernameChanged = username !== auth.username
  const passwordChanged = password.length > 0

  if (!currentPassword) {
    return res.status(400).json({ error: '请输入当前密码' })
  }

  if (!usernameChanged && !passwordChanged) {
    return res.status(400).json({ error: '没有可保存的修改' })
  }

  if (username.length < 3) {
    return res.status(400).json({ error: '用户名至少需要 3 个字符' })
  }

  if (passwordChanged && password.length < 8) {
    return res.status(400).json({ error: '新密码至少需要 8 位' })
  }

  const passwordOk = await verifyPassword(currentPassword, auth.passwordSalt, auth.passwordHash)
  if (!passwordOk) {
    return res.status(400).json({ error: '当前密码不正确' })
  }

  auth.username = username

  if (passwordChanged) {
    const { salt, hash } = await hashPassword(password)
    auth.passwordSalt = salt
    auth.passwordHash = hash
    auth.mustChangePassword = false
    await revokeAllSessions()
    return res.json({
      success: true,
      requiresRelogin: true,
      user: sanitizeAuthSettings()
    })
  }

  await settingsDb.write()
  res.json({
    success: true,
    requiresRelogin: false,
    user: sanitizeAuthSettings()
  })
})

export default router
