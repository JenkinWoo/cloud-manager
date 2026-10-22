import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { once } from 'node:events'
import express from 'express'
const accountsDb = { data: { accounts: [
  { id: 'a', name: 'Oracle', computeProvider: 'oracle', credentials: { secret: 'never-return' } },
  { id: 'b', name: 'Azure', computeProvider: 'azure' },
  { id: 'disabled', enabled: false }
] } }
mock.module(new URL('../backend/db.mjs', import.meta.url).href, { namedExports: { accountsDb } })
let fail = false
const calls = []
mock.module(new URL('../backend/providers/registry.mjs', import.meta.url).href, { namedExports: { getComputeProvider: account => ({ getBilling: async period => {
  calls.push({ id: account.id, period })
  if (fail) throw new Error('permission denied')
  return { status: 'ok', total: 1, currency: 'USD', services: [] }
} }) } })
const { default: billingRouter } = await import('../backend/routes/billing.mjs')
let server, base
before(async () => {
  const app = express()
  app.use('/billing', billingRouter)
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}/billing`
})
after(async () => { await new Promise(resolve => server.close(resolve)) })
test('listing accounts never queries billing or returns credentials', async () => {
  const r = await fetch(base)
  const body = await r.json()
  assert.equal(body.accounts.length, 2)
  assert.equal(calls.length, 0)
  assert.equal(JSON.stringify(body).includes('never-return'), false)
})
test('only the selected account is queried; refresh replaces its stable cache entry', async () => {
  const url = base + '/a?month=2026-09'
  await fetch(url)
  await fetch(url)
  assert.deepEqual(calls.map(c => c.id), ['a'])
  await fetch(url + '&refresh=true')
  await fetch(url)
  assert.deepEqual(calls.map(c => c.id), ['a', 'a'])
  assert.equal(calls[0].period.to, '2026-10-01T00:00:00.000Z')
})
test('provider failure is not cached as a successful zero; a retry can recover', async () => {
  fail = true
  const failed = await (await fetch(base + '/b?month=2026-09')).json()
  assert.equal(failed.account.total, null)
  assert.equal(failed.account.status, 'error')
  fail = false
  const recovered = await (await fetch(base + '/b?month=2026-09')).json()
  assert.equal(recovered.account.status, 'ok')
})
test('invalid/future periods and unavailable accounts are rejected before provider access', async () => {
  const before = calls.length
  for (const query of ['month=2026-13', 'month=9999-01', 'from=2026-02-30&to=2026-03-10']) assert.equal((await fetch(base + '/a?' + query)).status, 400)
  for (const id of ['missing', 'disabled']) assert.equal((await fetch(base + '/' + id)).status, 404)
  assert.equal(calls.length, before)
})
