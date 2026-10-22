import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import OracleProvider from '../backend/providers/compute/OracleProvider.mjs'
import AzureProvider from '../backend/providers/compute/AzureProvider.mjs'
import { billingTotals } from '../backend/utils/billing.mjs'

let awsQuery
mock.module('aws-sdk', { defaultExport: { CostExplorer: class {
  getCostAndUsage(request) { return { promise: () => awsQuery(request) } }
} } })
const { default: AwsProvider } = await import('../backend/providers/compute/AwsProvider.mjs')
const period = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }

test('Oracle accepts the API grouping limit and preserves actual quantity, missing currency and zero attributed cost', async () => {
  const p = new OracleProvider({ credentials: {} })
  p._ensureInitialized = async () => {}
  p._getHomeRegionId = async () => 'sa-saopaulo-1'
  p.compartmentId = 'test-tenancy'
  const requests = []
  p.usageClient = { requestSummarizedUsages: async request => {
    requests.push(request)
    assert.ok(request.requestSummarizedUsagesDetails.groupBy.length <= 4)
    return { usageAggregation: { items: [{ service: 'Compute', skuName: 'Free compute', unit: 'OCPU Hours', computedAmount: null, attributedCost: '0', computedQuantity: request.page ? 2 : 3, currency: ' ' }] }, opcNextPage: request.page ? null : 'page2' }
  } }
  const result = await p.getBilling(period)
  assert.equal(requests.length, 2)
  assert.equal(result.services[0].usage, 5)
  assert.equal(result.services[0].amount, 0)
  assert.equal(result.services[0].currency, '')
  assert.equal(result.currency, '未知币种')
  p.usageClient.requestSummarizedUsages = async () => { throw new Error('NotAuthorizedOrNotFound') }
  await assert.rejects(p.getBilling(period), /NotAuthorized/)
})

test('Azure uses paginated meter detail, separates quantities by unit and retains negative adjustments', async () => {
  const p = new AzureProvider({ credentials: { appId: 'test', password: 'test', tenant: 'test' } })
  const modern = (quantity, unitOfMeasure, cost) => ({ kind: 'modern', properties: { date: '2026-09-15T00:00:00Z', meterCategory: 'Storage', meterName: 'Disk', instanceName: 'disk-1', quantity, unitOfMeasure, costInBillingCurrency: cost, billingCurrencyCode: 'USD', effectivePrice: .01 } })
  const paths = []
  p._billingArmGet = async path => {
    paths.push(path)
    if (path === '/subscriptions') return { value: [{ subscriptionId: 's1', displayName: 'Student' }] }
    if (path.includes('page=2')) return { value: [modern(5, 'GB', 2), modern(1, 'Hour', -1)] }
    return { value: [modern(3, 'GB', 1), { ...modern(100, 'GB', 500), properties: { ...modern(100, 'GB', 500).properties, date: '2026-10-01T00:00:00Z' } }], nextLink: 'https://management.azure.com/subscriptions/s1/usage?page=2&api-version=2024-08-01' }
  }
  const result = await p.getBilling(period)
  assert.equal(result.status, 'ok')
  assert.equal(result.total, 2)
  assert.equal(result.services.length, 2)
  assert.equal(result.services[0].usage, 8)
  assert.equal(result.services[1].amount, -1)
  assert.equal(paths.length, 3)
  assert.ok(decodeURIComponent(paths[1]).includes("usageEnd le '2026-09-30'"))
  await assert.rejects(p._billingNextPage('https://example.com/steal-token'), /无效/)
})

test('Azure partial subscription failure never reports the available subtotal as complete', async () => {
  const p = new AzureProvider({ credentials: { appId: 'test', password: 'test', tenant: 'test' } })
  p._billingArmGet = async () => ({ value: [{ subscriptionId: 'ok' }, { subscriptionId: 'denied' }] })
  p._getUsageBilling = async id => {
    if (id === 'denied') throw new Error('AuthorizationFailed')
    return { services: [{ service: 'Compute', amount: 4, currency: 'USD' }], ...billingTotals([{ amount: 4, currency: 'USD' }]) }
  }
  const result = await p.getBilling(period)
  assert.equal(result.status, 'partial')
  assert.equal(result.total, null)
  assert.equal(result.totals[0].amount, 4)
  assert.match(result.subscriptions[1].error, /AuthorizationFailed/)
})

test('AWS paginates Cost Explorer and keeps usage types apart', async () => {
  const requests = []
  awsQuery = async req => {
    requests.push(req)
    return { ResultsByTime: [{ Estimated: true, Groups: [{ Keys: ['EC2', req.NextPageToken ? 'BoxUsage' : 'DataTransfer'], Metrics: { UnblendedCost: { Amount: '1.25', Unit: 'USD' }, UsageQuantity: { Amount: '3', Unit: req.NextPageToken ? 'Hrs' : 'GB' } } }] }], NextPageToken: req.NextPageToken ? undefined : 'next' }
  }
  const result = await new AwsProvider({ credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }).getBilling(period)
  assert.equal(requests.length, 2)
  assert.equal(result.total, 2.5)
  assert.equal(result.services.length, 2)
  assert.deepEqual(result.services.map(row => row.unit), ['GB', 'Hrs'])
  assert.equal(result.estimated, true)
})

test('unknown fees and different currencies cannot silently become one zero-dollar total', () => {
  assert.throws(() => billingTotals([{ amount: null }]), /费用缺失/)
  assert.equal(billingTotals([]).total, null)
  const result = billingTotals([{ amount: 1, currency: 'USD' }, { amount: 2, currency: 'GBP' }])
  assert.equal(result.total, null)
  assert.equal(result.totals.length, 2)
})
