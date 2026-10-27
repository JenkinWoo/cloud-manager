import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupBillingRows, billingTotals } from '../backend/utils/billing.mjs'
import { billingPeriod } from '../frontend/src/utils/billing.js'

test('grouping preserves separate charged dates and undated rows without changing totals', () => {
  const base = { service: 'Storage', meter: 'P6 LRS Disk', resource: 'disk', amount: 1, usage: .1, unit: 'Month', currency: 'USD' }
  const dated = date => ({ ...base, periodStart: date, periodEnd: date })
  const rows = groupBillingRows([dated('2026-10-01'), dated('2026-10-01'), dated('2026-10-03'), base])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].amount, 2)
  assert.equal(rows[0].usage, .2)
  assert.equal(rows[0].periodEnd, '2026-10-01')
  assert.equal(rows[1].periodStart, '2026-10-03')
  assert.equal(rows[2].periodStart, undefined)
  assert.equal(billingTotals(rows).total, 4)
})

test('date display preserves provider UTC days and distinguishes days from periods', () => {
  assert.equal(billingPeriod({ periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-01T23:59:59Z' }), '2026-10-01')
  assert.equal(billingPeriod({ periodStart: '2026-10-01', periodEnd: '2026-10-03' }), '2026-10-01 至 2026-10-03')
  assert.equal(billingPeriod({ periodStart: '2026-10-02T01:00:00+08:00', periodEnd: '2026-10-01T23:00:00' }), '2026-10-01')
})

test('exclusive AWS end dates do not display an extra charged day at month or leap-year boundaries', () => {
  assert.equal(billingPeriod({ periodStart: '2026-10-31', periodEnd: '2026-11-01', periodEndExclusive: true }), '2026-10-31')
  assert.equal(billingPeriod({ periodStart: '2024-02-01', periodEnd: '2024-03-01', periodEndExclusive: true }), '2024-02-01 至 2024-02-29')
})

test('missing and malformed dates remain unknown rather than using the query date', () => {
  assert.equal(billingPeriod({}), '日期未提供')
  assert.equal(billingPeriod({ periodStart: '2026-02-30', periodEnd: 'bad' }), '日期未提供')
  assert.equal(billingPeriod({ periodStart: '2026-10-01' }), '2026-10-01 起（结束日期未提供）')
  assert.equal(billingPeriod({ periodEnd: '2026-10-02' }), '截至 2026-10-02（开始日期未提供）')
})
