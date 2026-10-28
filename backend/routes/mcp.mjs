import { Router, json } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { findMcpToken, getMcpSettings } from '../utils/mcpAuth.mjs'
import { createMcpServer } from '../services/mcpServer.mjs'

const router = Router()
const limits = new Map()
const fail = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } })

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  res.vary('Origin')
  if (req.headers.origin) {
    if (!getMcpSettings().allowedOrigins.includes(req.headers.origin)) return fail(res, 403, 'Origin is not allowed')
    res.set('Access-Control-Allow-Origin', req.headers.origin)
    res.set('Access-Control-Expose-Headers', 'MCP-Protocol-Version, MCP-Session-Id')
  }
  if (req.path !== '/') return fail(res, 404, 'Unknown MCP endpoint')
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id')
    return res.sendStatus(204)
  }
  const token = findMcpToken(req.headers.authorization)
  if (!token) { res.set('WWW-Authenticate', 'Bearer realm="cloud-manager-mcp"'); return fail(res, 401, 'MCP is disabled or the bearer token is invalid/expired') }
  if (req.method !== 'POST') { res.set('Allow', 'POST, OPTIONS'); return fail(res, 405, 'Stateless MCP supports POST only') }
  const now = Date.now()
  for (const [key, entry] of limits) if (!entry.active && now - entry.start >= 60000) limits.delete(key)
  let entry = limits.get(token.id)
  if (!entry) { entry = { start: now, count: 0, active: 0 }; limits.set(token.id, entry) }
  if (now - entry.start >= 60000) { entry.start = now; entry.count = 0 }
  if (entry.count >= 120 || entry.active >= 8) { res.set('Retry-After', '60'); return fail(res, 429, 'MCP request limit exceeded') }
  entry.count++
  entry.active++
  let released = false
  const release = () => { if (!released) { released = true; entry.active-- } }
  // Keep execution slots occupied until handlers settle, even if a client disconnects.
  res.locals.mcpRelease = release
  res.locals.mcpToken = token
  next()
})
router.use(json({ limit: '128kb' }))
router.post('/', async (req, res) => {
  const server = createMcpServer(req, res.locals.mcpToken)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch {
    if (!res.headersSent) fail(res, 500, 'MCP request failed')
  } finally {
    await server.close().catch(() => {})
    res.locals.mcpRelease()
  }
})
router.use((error, req, res, next) => {
  res.locals.mcpRelease?.()
  if (res.headersSent) return next(error)
  fail(res, error.status === 413 ? 413 : 400, 'Invalid MCP request body')
})
export default router
