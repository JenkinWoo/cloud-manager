import assert from 'node:assert/strict'
import { test } from 'node:test'
import AzureProvider from '../backend/providers/compute/AzureProvider.mjs'
import { normalizeAzureCredentials } from '../backend/utils/azureCredentials.mjs'
import { getAzureFreeBenefits, azureFreeAllocationReason } from '../backend/utils/azureFreeBenefits.mjs'

const now = new Date('2026-10-15T00:00:00Z')
const vmRow = (overrides = {}) => ({ service: 'Virtual Machines', meter: 'B2ats v2 - Free', amount: 0, usage: 1, unit: 'Hour', region: 'northcentralus', ...overrides })
const diskRow = (overrides = {}) => ({ service: 'Storage', meter: 'P6 LRS Disk - Free', amount: 0, usage: .001, unit: '1/Month', region: 'northcentralus', ...overrides })

const freeRows = () => [vmRow(), diskRow(), vmRow({ region: 'westus', meter: 'B2pts v2 - Free' }), diskRow({ region: 'westus' })]
const state = (overrides = {}) => {
  const rows = overrides.rows || freeRows()
  return { benefit: getAzureFreeBenefits(rows), inventory: { vms: [], disks: [] }, now,
    location: 'northcentralus', vmSize: 'Standard_B2ats_v2', ...overrides, rows }
}

test('existing accounts need no manual benefits; only explicit Free meters with positive usage count', () => {
  const credentials = normalizeAzureCredentials({ tenant: 'test', appId: 'test', password: 'test', freeBenefits: [{ subscriptionId: 'sub' }] })
  assert.equal(Object.hasOwn(credentials, 'freeBenefits'), false)
  assert.equal(azureFreeAllocationReason(state()), '')
  for (const row of [vmRow({ meter: 'B2ats v2' }), vmRow({ usage: 0 }), vmRow({ usage: null }), vmRow({ amount: -1 }),
    vmRow({ unit: 'GB' }), vmRow({ region: '' })]) assert.deepEqual(getAzureFreeBenefits([row]).vmRegions, [])
  assert.deepEqual(getAzureFreeBenefits([diskRow({ meter: 'S4 LRS Disk Operations - Free' })]).diskRegions, [])
  assert.deepEqual(getAzureFreeBenefits([vmRow({ region: 'North Central US' }), vmRow()]).vmRegions,
    [{ vmSize: 'Standard_B2ats_v2', location: 'northcentralus' }])
})

test('VM and disk evidence must each match the selected region and machine', () => {
  assert.match(azureFreeAllocationReason(state({ rows: [vmRow(), diskRow({ region: 'westus' })] })), /P6/)
  assert.match(azureFreeAllocationReason(state({ location: 'westus' })), /Free/)
  assert.match(azureFreeAllocationReason(state({ vmSize: 'Standard_B1s' })), /Free/)
})

test('paid VM usage in any region and paid P6 capacity block creation; S4 and paid IPv4 do not grant or consume P6 benefits', () => {
  assert.match(azureFreeAllocationReason(state({ rows: [vmRow({ meter: 'B2ats v2', amount: 1, region: 'westus' })] })), /实际计算费用/)
  assert.match(azureFreeAllocationReason(state({ rows: [diskRow({ meter: 'P6 LRS Disk', amount: 1 })] })), /磁盘已有实际费用/)
  assert.equal(azureFreeAllocationReason(state({ rows: [...freeRows(), diskRow({ meter: 'S4 LRS Disk', amount: 1 }),
    { service: 'Virtual Network', meter: 'Standard IPv4 Static Public IP', amount: 5 }] })), '')
})

test('historical usage remains consumed after deletion and remaining capacity must cover the rest of the month', () => {
  assert.match(azureFreeAllocationReason(state({ rows: [vmRow({ usage: 749 }), diskRow()] })), /不足/)
  assert.match(azureFreeAllocationReason(state({ rows: [vmRow(), diskRow({ usage: 1.9 })] })), /不足/)
  assert.match(azureFreeAllocationReason(state({ rows: [vmRow({ usage: null })] })), /不完整/)
  assert.match(azureFreeAllocationReason(state({ rows: [diskRow({ unit: 'Hour' })] })), /不完整/)
})

function provider() {
  const p = new AzureProvider({ credentials: { tenant: 'test', appId: 'test', password: 'test' } })
  p.subscriptionId = p.selectedSubscriptionId = 'sub'
  p.subscription = { state: 'Enabled', subscriptionPolicies: { quotaId: 'AzureForStudents_2018-01-01' } }
  p._ensureInitialized = async () => {}
  p.listLocations = async () => ['denmarkeast', 'northcentralus', 'westus'].map(name => ({ name, displayName: name }))
  p._listVmSizes = async () => ['Standard_B1s', 'Standard_B2pts_v2', 'Standard_B2ats_v2'].map(name => ({ name, available: true }))
  p.computeClient = { virtualMachines: { listAll: async function* () {}, get: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }) } },
    disks: { list: async function* () {} } }
  p._getUsageBilling = async () => ({ services: freeRows() })
  p._assertLocationAllowed = p._assertVmSizeAvailable = async () => {}
  p._ensureResourceProvidersRegistered = async () => assert.fail('rejected create reached first Azure write')
  return p
}

test('frontend recommendations and backend omitted defaults use the same eligible regions and machine sizes', async () => {
  const p = provider()
  const options = await p.listCreateOptions('sub')
  assert.equal(options.options[0].vmSize, 'Standard_B2ats_v2')
  assert.ok(options.options.every(option => option.location !== 'denmarkeast' && option.vmSize !== 'Standard_B1s'))
  const selected = await p.prepareFreeCreate({ subscriptionId: 'sub' })
  assert.equal(selected.location, options.options[0].location)
  assert.equal(selected.vmSize, options.options[0].vmSize)
  assert.equal((await p.prepareFreeCreate({ subscriptionId: 'sub', vmSize: 'Standard_B2pts_v2' })).vmSize, 'Standard_B2pts_v2')
  await assert.rejects(p.prepareFreeCreate({ subscriptionId: 'sub', location: 'denmarkeast' }), { code: 'FreeOnlyMode' })
  await assert.rejects(p.prepareFreeCreate({ subscriptionId: 'sub', location: 'westus', vmSize: 'Standard_B1s', freeVerified: true }), { code: 'FreeOnlyMode' })
})

test('inventory exhaustion removes recommendations and missing billing permissions never become zero usage', async () => {
  const p = provider()
  p.computeClient.disks.list = async function* () {
    yield { id: 'unattached-1', sku: { name: 'Premium_LRS' }, diskSizeGB: 64 }
    yield { id: 'unattached-2', sku: { name: 'Premium_LRS' }, tier: 'P6' }
  }
  const result = await p.listCreateOptions('sub')
  assert.deepEqual(result.options, [])
  assert.equal(result.costPolicy.creationAllowed, false)
  p._getUsageBilling = async () => { throw new Error('AuthorizationFailed') }
  await assert.rejects(p.listCreateOptions('sub'), /AuthorizationFailed/)
})

test('queued creation rechecks current benefits, usage and inventory before any Azure writes', async () => {
  const params = { subscriptionId: 'sub', vmSize: 'Standard_B2ats_v2', location: 'northcentralus', adminPassword: 'Test-only-password123!', freeVerified: true }
  const p = provider()
  await p.prepareFreeCreate(params)
  p._getUsageBilling = async () => ({ services: [] })
  await assert.rejects(p.createInstance(params), { code: 'FreeOnlyMode' })
  p._getUsageBilling = async () => ({ services: [diskRow({ amount: 1 })] })
  await assert.rejects(p.createInstance(params), /磁盘已有实际费用/)
  p._getUsageBilling = async () => ({ services: freeRows() })
  p.computeClient.virtualMachines.listAll = async function* () { yield { id: 'external-vm', hardwareProfile: { vmSize: params.vmSize } } }
  await assert.rejects(p.createInstance(params), /共享/)
})

test('missing billing evidence gives reasons without directing users to account settings', async () => {
  const p = provider()
  p._getUsageBilling = async () => ({ services: [] })
  p._listVmSizes = async () => assert.fail('do not scan CPU quota without free billing evidence')
  const result = await p.listCreateOptions('sub')
  assert.deepEqual(result.options, [])
  assert.equal(result.costPolicy.creationAllowed, false)
  assert.equal(result.regions.length, 3)
  assert.match(result.regions[0].sizes[0].restrictionReason, /Free/)
  assert.doesNotMatch(JSON.stringify(result), /请在账户设置|请填写/)
  assert.equal(result.benefit.source, 'current-month-free-meters')
  assert.equal(result.benefit.validUntil, undefined, 'do not invent an expiry date')
})
