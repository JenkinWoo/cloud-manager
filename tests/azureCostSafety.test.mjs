import assert from 'node:assert/strict'
import { test } from 'node:test'
import AzureProvider from '../backend/providers/compute/AzureProvider.mjs'
import { validateAzureFreeCreateParams, assertAzureFreeSubscription, withAzureAllocationLock } from '../backend/utils/azureCostPolicy.mjs'
import { azureFreeAllocationReason } from '../backend/utils/azureFreeBenefits.mjs'

const id = (type, name, subscription = 'sub') => `/subscriptions/${subscription}/resourceGroups/group/providers/${type}/${name}`
const vmId = id('Microsoft.Compute/virtualMachines', 'vm')
const diskId = id('Microsoft.Compute/disks', 'os')
const nicId = id('Microsoft.Network/networkInterfaces', 'nic')
const ipId = id('Microsoft.Network/publicIPAddresses', 'pip')
const missing = () => Object.assign(new Error('Not found'), { statusCode: 404 })
function fixture() {
  const p = new AzureProvider({ credentials: { tenant: 'test', appId: 'test', password: 'test' } })
  p.subscriptionId = 'sub'
  p.selectedSubscriptionId = 'sub'
  p.subscription = { subscriptionId: 'sub', state: 'Enabled', subscriptionPolicies: { quotaId: 'AzureForStudents_2018-01-01' } }
  p._ensureInitialized = async () => {}
  p._getFreeVmCharges = async () => []
  p._getUsageBilling = async () => ({ services: ['region', 'denied'].flatMap(region => [
    ...['B1s', 'B2ats v2', 'B2pts v2'].map(meter => ({ service: 'Virtual Machines', meter: meter + ' - Free', region, amount: 0, usage: 1, unit: 'Hour' })),
    { service: 'Storage', meter: 'P6 LRS Disk - Free', region, amount: 0, usage: .001, unit: '1/Month' }
  ]) })
  const vm = { id: vmId, name: 'vm', tags: { managedBy: 'cloud-manager' },
    storageProfile: { osDisk: { createOption: 'FromImage', managedDisk: { id: diskId } }, dataDisks: [] },
    networkProfile: { networkInterfaces: [{ id: nicId, deleteOption: 'Delete' }] } }
  const rows = new Map([
    [diskId, { id: diskId, diskState: 'Unattached' }],
    [nicId, { id: nicId, tags: { managedBy: 'cloud-manager', vmName: 'vm' }, ipConfigurations: [{ publicIPAddress: { id: ipId } }] }],
    [ipId, { id: ipId, name: 'pip', tags: { managedBy: 'cloud-manager', vmName: 'vm' }, provisioningState: 'Succeeded' }]
  ])
  const deleted = []
  let vmDeleted = false
  const client = type => ({
    get: async (rg, name) => { const row = rows.get(id(type, name)); if (!row) throw missing(); return structuredClone(row) },
    beginDeleteAndWait: async (rg, name) => {
      assert.equal(vmDeleted, true, 'dependencies deleted only after VM');
      const resourceId = id(type, name); deleted.push(resourceId); rows.delete(resourceId)
    }
  })
  p.computeClient = { disks: { ...client('Microsoft.Compute/disks'), list: async function* () {} }, virtualMachines: {
    listAll: async function* () {},
    get: async () => structuredClone(vm),
    beginDeleteAndWait: async () => { vmDeleted = true; deleted.push(vmId) }
  } }
  p.networkClient = { networkInterfaces: client('Microsoft.Network/networkInterfaces'), publicIPAddresses: client('Microsoft.Network/publicIPAddresses') }
  return { p, vm, rows, deleted }
}

test('free VM policy rejects paid SKUs, incompatible images and paid disks before Azure writes', async () => {
  const { p } = fixture()
  p._ensureInitialized = async () => assert.fail('blocked operation reached Azure')
  const old = process.env.AZURE_FREE_ONLY
  process.env.AZURE_FREE_ONLY = 'false'
  try {
    for (const params of [{ vmSize: 'Standard_D4s_v3' }, { vmSize: 'toString' }, { storageAccountType: 'Standard_LRS' },
      { diskSizeGB: 128 }, { imagePublisher: 'paid-marketplace' },
      { vmSize: 'Standard_B2pts_v2', imageSku: '22_04-lts-gen2' }]) {
      await assert.rejects(p.createInstance({ ...params, freeOnly: false, freeVerified: true }, { creationId: 'old-queued-job' }),
        { code: 'FreeOnlyMode', statusCode: 403, retryable: false })
    }
    for (const ipTypes of [['ipv4'], ['ipv6'], ['ipv4', 'ipv6']]) await assert.rejects(p.switchPublicIp(vmId, { ipTypes }), { statusCode: 403 })
    assert.equal(AzureProvider.capabilities.includes('switch_ip'), false)
  } finally {
    if (old === undefined) delete process.env.AZURE_FREE_ONLY
    else process.env.AZURE_FREE_ONLY = old
  }
})

test('recommendations include available x64 and ARM free sizes and preserve regional failures', async () => {
  const { p } = fixture()
  p.listLocations = async () => [{ name: 'region', displayName: 'Region' }, { name: 'denied', displayName: 'Denied' }]
  p._listVmSizes = async (client, location) => {
    if (location === 'denied') throw new Error('Quota lookup failed')
    return Object.keys((await import('../backend/utils/azureCostPolicy.mjs')).AZURE_FREE_VM_PROFILES).map(name => ({
      name, available: true, architecture: validateAzureFreeCreateParams({ vmSize: name }).architecture, quota: { remainingCores: 4 }
    }))
  }
  const result = await p.listCreateOptions('sub')
  assert.equal(result.options.length, 3)
  assert.ok(result.options.some(o => o.architecture === 'Arm64'))
  assert.equal(result.regions.find(r => r.location === 'denied').status, 'unknown')
  assert.equal(result.costPolicy.creationAllowed, true)
})

test('all three free sizes deploy a matching Ubuntu image, one P6 disk and no public IP; retries reuse the VM', async () => {
  for (const vmSize of ['Standard_B1s', 'Standard_B2ats_v2', 'Standard_B2pts_v2']) {
    const { p } = fixture()
    const writes = [], vms = []
    p.computeClient.virtualMachines.get = async () => { if (!vms.length) throw missing(); return vms[0] }
    p.computeClient.virtualMachines.listAll = async function* () { yield* vms }
    p.computeClient.disks.list = async function* () {}
    p._assertLocationAllowed = p._assertVmSizeAvailable = p._ensureResourceProvidersRegistered = async () => {}
    p._ensureDefaultNetwork = async () => ({ resourceGroupName: 'group', networkSecurityGroup: { id: 'nsg' }, subnet: { id: 'subnet' } })
    p.networkClient.networkInterfaces.beginCreateOrUpdateAndWait = async (group, name, body) => {
      writes.push({ kind: 'nic', body }); return { id: nicId }
    }
    p.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait = async () => assert.fail('paid IP allocated')
    p.computeClient.virtualMachines.beginCreateOrUpdateAndWait = async (group, name, body) => {
      writes.push({ kind: 'vm', body })
      const vm = { ...body, name, id: vmId, provisioningState: 'Succeeded' }; vms.push(vm); return vm
    }
    const params = { subscriptionId: 'sub', location: 'region', vmSize, adminPassword: 'Test-only-password123!' }
    await p.createInstance(params, { creationId: 'stable-task' })
    assert.equal(writes.length, 2)
    assert.equal(writes[0].body.ipConfigurations[0].publicIPAddress, undefined)
    assert.equal(writes[1].body.storageProfile.osDisk.diskSizeGB, 64)
    assert.equal(writes[1].body.storageProfile.osDisk.managedDisk.storageAccountType, 'Premium_LRS')
    assert.equal(writes[1].body.storageProfile.imageReference.sku, vmSize === 'Standard_B2pts_v2' ? '22_04-lts-arm64' : '22_04-lts-gen2')
    await p.createInstance(params, { creationId: 'stable-task' })
    assert.equal(writes.length, 2, 'retry must not deploy a second disk or VM')
  }
})

test('inventory check includes other regions and unattached disks', async () => {
  const { p } = fixture()
  p.computeClient.virtualMachines.listAll = async function* () { yield { id: 'other-region', hardwareProfile: { vmSize: 'Standard_B1s' } } }
  p.computeClient.disks.list = async function* () { for (const n of [1, 2]) yield { id: 'disk-' + n, sku: { name: 'Premium_LRS' }, diskSizeGB: 64 } }
  const state = { ...await p._getFreeCreateState(), now: new Date('2026-10-15T00:00:00Z') }
  assert.match(azureFreeAllocationReason({ ...state, location: 'region', vmSize: 'Standard_B1s' }), /共享/)
  assert.match(azureFreeAllocationReason({ ...state, location: 'region', vmSize: 'Standard_B2ats_v2' }), /占满/)
  assert.equal(azureFreeAllocationReason({ ...state, location: 'region', vmSize: 'Standard_B2ats_v2', diskId: 'disk-1' }), '')
})

test('paid or disabled subscriptions cannot pass by changing their display name', () => {
  for (const subscription of [{ state: 'Enabled', displayName: 'Azure for Students', subscriptionPolicies: { quotaId: 'PayAsYouGo' } },
    { state: 'Disabled', subscriptionPolicies: { quotaId: 'AzureForStudents_2018-01-01' } }]) {
    assert.throws(() => assertAzureFreeSubscription(subscription), { code: 'FreeOnlyMode' })
  }
})

test('actual VM charges block only the affected region and size and ignore unrelated disk costs', async () => {
  const { p } = fixture()
  delete p._getFreeVmCharges
  p._getUsageBilling = async () => ({ services: [
    { service: 'Virtual Machines', meter: 'B1s', region: 'denmarkeast', amount: 2.58 },
    { service: 'Virtual Machines', meter: 'B2ats v2', region: 'northcentralus', amount: 0 },
    { service: 'Storage', meter: 'S4 LRS Disk', region: 'northcentralus', amount: .68 }
  ] })
  const charges = await p._getFreeVmCharges('test-charge-sub', true)
  assert.deepEqual(charges, [{ vmSize: 'Standard_B1s', location: 'denmarkeast' }])
  const sizes = ['Standard_B1s', 'Standard_B2ats_v2', 'Standard_B2pts_v2'].map(name => ({ name, available: true }))
  assert.deepEqual(p._applyVmCharges(sizes, 'denmarkeast', charges).map(s => s.available), [false, true, true])
  assert.deepEqual(p._applyVmCharges(sizes, 'northcentralus', charges).map(s => s.available), [true, true, true])
})

test('free instance start and reboot work while paid VM sizes are blocked', async () => {
  const { p, vm } = fixture(), calls = []
  vm.hardwareProfile = { vmSize: 'Standard_B2pts_v2' }
  p.computeClient.virtualMachines.beginStartAndWait = async () => calls.push('START')
  p.computeClient.virtualMachines.beginRestartAndWait = async () => calls.push('REBOOT')
  await p.instanceAction(vmId, 'START')
  await p.instanceAction(vmId, 'REBOOT')
  assert.deepEqual(calls, ['START', 'REBOOT'])
  vm.hardwareProfile.vmSize = 'Standard_D4s_v3'
  await assert.rejects(p.instanceAction(vmId, 'START'), { code: 'FreeOnlyMode' })
  assert.equal(calls.length, 2)
})

test('allocations serialize per subscription and a failed task does not hold the lock', async () => {
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = withAzureAllocationLock('SUB', async () => { calls.push(1); await gate; throw new Error('failure') })
  const second = withAzureAllocationLock('sub', async () => { calls.push(2) })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [1])
  release()
  await assert.rejects(first, /failure/)
  await second
  assert.deepEqual(calls, [1, 2])
})

test('STOP deallocates and rejects a different subscription or resource type', async () => {
  const { p } = fixture()
  const calls = []
  p.computeClient.virtualMachines.beginDeallocateAndWait = async (...args) => calls.push(args)
  p.computeClient.virtualMachines.beginPowerOffAndWait = async () => assert.fail('power off still bills')
  await p.instanceAction(vmId, 'STOP')
  assert.deepEqual(calls, [['group', 'vm']])
  await assert.rejects(p.instanceAction(id('Microsoft.Compute/virtualMachines', 'vm', 'foreign'), 'STOP'), { statusCode: 400 })
  await assert.rejects(p.instanceAction(nicId, 'STOP'), { statusCode: 400 })
  assert.equal(calls.length, 1)
})

test('VM deletion also removes a legacy OS disk and its dedicated NIC and public IP', async () => {
  const { p, deleted, rows } = fixture()
  const result = await p.deleteInstance(vmId)
  assert.deepEqual(deleted, [vmId, nicId, ipId, diskId])
  assert.equal(rows.size, 0)
  assert.equal(result.cleanup.complete, true)
})

test('resources already deleted by Azure cascade are treated as cleaned', async () => {
  const { p, rows } = fixture()
  p.computeClient.virtualMachines.beginDeleteAndWait = async () => rows.clear()
  const result = await p.deleteInstance(vmId)
  assert.equal(result.cleanup.complete, true)
  assert.equal(result.cleanup.deleted.length, 3)
})

test('retains external data disks but deletes all bound public IPs including manually selected addresses', async () => {
  const { p, vm, rows, deleted } = fixture()
  const external = id('Microsoft.Compute/disks', 'external')
  vm.storageProfile.dataDisks.push({ managedDisk: { id: external }, deleteOption: 'Detach' })
  rows.get(ipId).tags = {}
  const result = await p.deleteInstance(vmId)
  assert.equal(result.cleanup.complete, false)
  assert.deepEqual(result.cleanup.retained.map(r => r.id), [external])
  assert.equal(deleted.includes(external), false)
  assert.equal(deleted.includes(ipId), true)
})

test('a resource reused during deletion is not deleted and an API failure is reported', async () => {
  const { p, rows, deleted } = fixture()
  rows.get(diskId).managedBy = id('Microsoft.Compute/virtualMachines', 'another')
  p.networkClient.publicIPAddresses.beginDeleteAndWait = async () => { throw new Error('AuthorizationFailed') }
  const result = await p.deleteInstance(vmId)
  assert.equal(result.cleanup.complete, false)
  assert.equal(result.cleanup.failed.length, 2)
  assert.equal(deleted.includes(diskId), false)
  assert.equal(deleted.includes(ipId), false)
})

test('foreign dependency IDs and failed inventory reads prevent VM deletion', async () => {
  const { p, vm, deleted } = fixture()
  vm.networkProfile.networkInterfaces[0].id = id('Microsoft.Network/networkInterfaces', 'nic', 'foreign')
  await assert.rejects(p.deleteInstance(vmId), { statusCode: 400 })
  assert.deepEqual(deleted, [])
  vm.networkProfile.networkInterfaces[0].id = nicId
  p.networkClient.networkInterfaces.get = async () => { throw new Error('read denied') }
  await assert.rejects(p.deleteInstance(vmId), /read denied/)
  assert.deepEqual(deleted, [])
})
