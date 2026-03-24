import crypto from 'crypto'
import { settingsDb } from '../db.mjs'

const HASH_ITERATIONS = 120000
const HASH_KEYLEN = 64
const HASH_DIGEST = 'sha512'
const DEFAULT_USERNAME = process.env.AUTH_USERNAME || 'admin'
const DEFAULT_PASSWORD = process.env.AUTH_PASSWORD || 'admin123'

function pbkdf2Async(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey.toString('hex'))
    })
  })
}

export async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await pbkdf2Async(password, salt)
  return { salt, hash }
}

export async function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false
  const candidate = await pbkdf2Async(password, salt)
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'))
}

export async function ensureAuthConfig() {
  const settings = settingsDb.data
  settings.auth ||= {}
  settings.auth.username ||= DEFAULT_USERNAME
  settings.auth.sessions ||= []

  if (!settings.auth.passwordHash || !settings.auth.passwordSalt) {
    const { salt, hash } = await hashPassword(DEFAULT_PASSWORD)
    settings.auth.passwordSalt = salt
    settings.auth.passwordHash = hash
    settings.auth.mustChangePassword = true
    await settingsDb.write()
    console.log(`Initialized default login: ${settings.auth.username} / ${DEFAULT_PASSWORD}`)
  }
}

export function sanitizeAuthSettings() {
  const auth = settingsDb.data.auth || {}
  return {
    username: auth.username || DEFAULT_USERNAME,
    mustChangePassword: Boolean(auth.mustChangePassword)
  }
}

export function issueSession() {
  const auth = settingsDb.data.auth
  const token = crypto.randomBytes(32).toString('hex')
  const now = new Date().toISOString()

  auth.sessions = (auth.sessions || []).slice(-9)
  auth.sessions.push({
    token,
    createdAt: now,
    lastUsedAt: now
  })

  return token
}

export function findSession(token) {
  const sessions = settingsDb.data.auth?.sessions || []
  return sessions.find((session) => session.token === token)
}

export async function revokeSession(token) {
  const auth = settingsDb.data.auth
  auth.sessions = (auth.sessions?.filter((session) => session.token !== token)) || []
  await settingsDb.write()
}

export async function revokeAllSessions() {
  settingsDb.data.auth.sessions = []
  await settingsDb.write()
}
