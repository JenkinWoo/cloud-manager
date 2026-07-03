import { spawn } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const children = new Set()
let shuttingDown = false
const frontendDir = resolve(rootDir, 'frontend')
const viteBin = resolve(frontendDir, 'node_modules/vite/bin/vite.js')

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    })
    killer.unref()
    return
  }

  child.kill('SIGTERM')
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return
  }

  shuttingDown = true

  for (const child of children) {
    killChild(child)
  }

  setTimeout(() => {
    process.exit(exitCode)
  }, 300)
}

function startProcess(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    ...options,
  })

  children.add(child)

  child.on('error', (error) => {
    console.error(`[dev] Failed to start ${name}:`, error.message)
    shutdown(1)
  })

  child.on('exit', (code, signal) => {
    children.delete(child)

    if (shuttingDown) {
      return
    }

    if (signal) {
      console.log(`[dev] ${name} exited with signal ${signal}, shutting down...`)
      shutdown(1)
      return
    }

    console.log(`[dev] ${name} exited with code ${code ?? 0}, shutting down...`)
    shutdown(code ?? 0)
  })

  return child
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('[dev] Starting backend with hot reload and frontend dev server...')

startProcess('backend', process.execPath, [
  '--watch',
  '--watch-preserve-output',
  'backend/server.mjs',
])

startProcess('frontend', process.execPath, [viteBin], { cwd: frontendDir })
