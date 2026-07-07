import express from 'express'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const router = express.Router()
const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const packagePath = resolve(projectRoot, 'package.json')
const latestPackageUrl =
  process.env.APP_UPDATE_PACKAGE_URL ||
  'https://raw.githubusercontent.com/JenkinWoo/cloud-manager/master/package.json'
const releaseUrl =
  process.env.APP_UPDATE_RELEASE_URL ||
  'https://github.com/JenkinWoo/cloud-manager/releases'
const updateScript = process.env.APP_UPDATE_SCRIPT || ''
const updateWebhookUrl = process.env.APP_UPDATE_WEBHOOK_URL || ''
const updateWebhookToken = process.env.APP_UPDATE_WEBHOOK_TOKEN || ''

let cachedResult = null
let cachedAt = 0
const CACHE_TTL_MS = 10 * 60 * 1000

async function readCurrentPackage() {
  return JSON.parse(await readFile(packagePath, 'utf8'))
}

function normalizeVersion(version = '') {
  return String(version).trim().replace(/^v/i, '').split('-')[0]
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number(part) || 0)
  const rightParts = normalizeVersion(right).split('.').map((part) => Number(part) || 0)
  const length = Math.max(leftParts.length, rightParts.length, 3)

  for (let i = 0; i < length; i += 1) {
    const diff = (leftParts[i] || 0) - (rightParts[i] || 0)
    if (diff !== 0) return diff
  }

  return 0
}

function getUpdateScriptPath() {
  if (!updateScript) return ''
  return resolve(projectRoot, updateScript)
}

async function ensureUpdateScriptReady() {
  const scriptPath = getUpdateScriptPath()
  if (!scriptPath) return null

  await access(scriptPath, constants.R_OK | constants.X_OK)
  return scriptPath
}

async function triggerUpdateWebhook(currentPackage, latest) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'cloud-manager-update-trigger'
  }

  if (updateWebhookToken) {
    headers.Authorization = `Bearer ${updateWebhookToken}`
  }

  const response = await fetch(updateWebhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      current: currentPackage.version,
      latest: latest.version,
      source: latest.source
    }),
    signal: AbortSignal.timeout(30000)
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error = new Error(`更新触发失败: ${response.status}`)
    error.detail = text.slice(0, 300)
    throw error
  }
}

async function triggerUpdateScript(currentPackage, latest) {
  const scriptPath = await ensureUpdateScriptReady()
  const child = spawn(scriptPath, [currentPackage.version, latest.version], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      APP_CURRENT_VERSION: currentPackage.version,
      APP_LATEST_VERSION: latest.version,
      APP_UPDATE_SOURCE: latest.source,
      APP_RELEASE_URL: releaseUrl
    }
  })

  child.unref()
}

async function fetchLatestVersion() {
  const now = Date.now()
  if (cachedResult && now - cachedAt < CACHE_TTL_MS) return cachedResult

  const response = await fetch(latestPackageUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'cloud-manager-version-check'
    },
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    throw new Error(`GitHub version check failed: ${response.status}`)
  }

  const latestPackage = await response.json()
  cachedResult = {
    version: latestPackage.version,
    checkedAt: new Date().toISOString(),
    source: latestPackageUrl
  }
  cachedAt = now
  return cachedResult
}

router.get('/', async (req, res) => {
  const currentPackage = await readCurrentPackage()
  const result = {
    current: currentPackage.version,
    latest: null,
    updateAvailable: false,
    updateMode: updateScript ? 'script' : updateWebhookUrl ? 'webhook' : '',
    updateSupported: Boolean(updateScript || updateWebhookUrl),
    checkedAt: null,
    source: latestPackageUrl,
    releaseUrl,
    error: null
  }

  try {
    const latest = await fetchLatestVersion()
    result.latest = latest.version
    result.checkedAt = latest.checkedAt
    result.source = latest.source
    result.updateAvailable = compareVersions(latest.version, currentPackage.version) > 0
  } catch (error) {
    result.error = error.message
  }

  res.json(result)
})

router.post('/update', async (req, res) => {
  if (!updateScript && !updateWebhookUrl) {
    return res.status(400).json({ error: '自动更新未配置' })
  }

  const currentPackage = await readCurrentPackage()
  const latest = await fetchLatestVersion()
  const updateAvailable = compareVersions(latest.version, currentPackage.version) > 0

  if (!updateAvailable) {
    return res.status(409).json({ error: '当前已经是最新版本' })
  }

  try {
    if (updateScript) {
      await triggerUpdateScript(currentPackage, latest)
    }

    res.json({
      success: true,
      status: updateScript ? 'started' : 'watching',
      current: currentPackage.version,
      latest: latest.version
    })

    if (!updateScript && updateWebhookUrl) {
      setTimeout(() => {
        triggerUpdateWebhook(currentPackage, latest).catch((error) => {
          console.error('Failed to trigger update webhook:', error.message, error.detail || '')
        })
      }, 1000)
    }
  } catch (error) {
    res.status(502).json({
      error: error.message || '更新触发失败',
      detail: error.detail || null
    })
  }
})

export default router
