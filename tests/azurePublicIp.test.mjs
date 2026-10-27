import assert from 'node:assert/strict'
import { test } from 'node:test'
import AzureProvider from '../backend/providers/compute/AzureProvider.mjs'
import { validateAzureFreeCreateParams } from '../backend/utils/azureCostPolicy.mjs'

const resourceId = (type, name, subscription = 'sub', group = 'group') =>
  `/subscriptions/${subscription}/resourceGroups/${group}/providers/${type}/${name}`
const vmId = resourceId('Microsoft.Compute/virtualMachines', 'vm')
const nicId = resourceId('Microsoft.Network/networkInterfaces', 'nic')
const ipId = resourceId('Microsoft.Network/publicIPAddresses', 'reserved', 'sub', 'network-group')
const notFound = () => Object.assign(new Error('Not found'), { statusCode: 404 })

function fixture() {
  const p = new AzureProvider({ name: 'test', credentials: { tenant: 'test', appId: 'test', password: 'test' } })
  p.subscriptionId = p.selectedSubscriptionId = 'sub'
  p.subscription = { state: 'Enabled', subscriptionPolicies: { quotaId: 'AzureForStudents_2018-01-01' } }
  p._ensureInitialized = async () => {}
  p._defaultResourceGroupName = () => 'group'
  p._getFreeVmCharges = async () => []
  p._getUsageBilling = async () => ({ services: [
    { service: 'Virtual Machines', meter: 'B2ats v2 - Free', region: 'region', amount: 0, usage: 1, unit: 'Hour' },
    { service: 'Storage', meter: 'P6 LRS Disk - Free', region: 'region', amount: 0, usage: .001, unit: '1/Month' }
  ] })
  p._assertLocationAllowed = p._assertVmSizeAvailable = p._ensureResourceProvidersRegistered = async () => {}
  p._ensureResourceGroup = async () => ({ name: 'group' })
  p._ensureDefaultNetwork = async () => ({ resourceGroupName: 'group', networkSecurityGroup: { id: 'nsg' }, subnet: { id: 'subnet' } })
  const vm = { id: vmId, name: 'vm', location: 'region', tags: { managedBy: 'cloud-manager' },
    hardwareProfile: { vmSize: 'Standard_B1s' }, storageProfile: {},
    networkProfile: { networkInterfaces: [{ id: nicId, primary: true, deleteOption: 'Delete' }] } }
  const nic = { id: nicId, name: 'nic', location: 'region', etag: 'v1', provisioningState: 'Succeeded',
    virtualMachine: { id: vmId }, tags: { managedBy: 'cloud-manager', vmName: 'vm' },
    enableIPForwarding: true, dnsSettings: { dnsServers: ['10.0.0.5'] },
    ipConfigurations: [{ id: nicId + '/ipConfigurations/main', name: 'main', primary: true,
      privateIPAddress: '10.0.0.4', privateIPAddressVersion: 'IPv4', privateIPAllocationMethod: 'Static', subnet: { id: 'subnet' } },
    { name: 'ipv6', privateIPAddressVersion: 'IPv6', privateIPAddress: 'fd00::1' }] }
  const vms = new Map([[vmId, vm]]), nics = new Map([[nicId, nic]]), ips = new Map()
  const writes = [], deleted = []
  let quotaRemaining = 5
  const get = (rows, key) => { if (!rows.has(key)) throw notFound(); return structuredClone(rows.get(key)) }
  function syncAssociations() {
    for (const ip of ips.values()) {
      delete ip.ipConfiguration
      for (const row of nics.values()) for (const config of row.ipConfigurations || []) {
        if (config.publicIPAddress?.id === ip.id) ip.ipConfiguration = { id: `${row.id}/ipConfigurations/${config.name}` }
      }
    }
  }
  function addIp(overrides = {}) {
    const ip = { id: ipId, name: 'reserved', location: 'region', ipAddress: '203.0.113.8',
      sku: { name: 'Standard', tier: 'Regional' }, publicIPAllocationMethod: 'Static',
      publicIPAddressVersion: 'IPv4', provisioningState: 'Succeeded', ...overrides }
    ips.set(ip.id, ip)
    return ip
  }
  p._listNetworkUsage = async () => ['PublicIPAddresses', 'IPv4StandardSkuPublicIpAddresses']
    .map(value => ({ name: { value }, limit: 10, currentValue: 10 - quotaRemaining }))
  p.computeClient = { disks: { list: async function* () {} }, virtualMachines: {
    get: async (group, name) => get(vms, resourceId('Microsoft.Compute/virtualMachines', name, 'sub', group)),
    listAll: async function* () { yield* vms.values() },
    beginCreateOrUpdateAndWait: async (group, name, body) => {
      writes.push({ kind: 'vm', body })
      const id = resourceId('Microsoft.Compute/virtualMachines', name, 'sub', group)
      const row = { ...structuredClone(body), id, name, provisioningState: 'Succeeded' }
      vms.set(id, row)
      for (const ref of row.networkProfile.networkInterfaces) nics.get(ref.id).virtualMachine = { id }
      return row
    },
    beginDeleteAndWait: async (group, name) => {
      const id = resourceId('Microsoft.Compute/virtualMachines', name, 'sub', group)
      deleted.push(id); vms.delete(id)
      for (const row of nics.values()) if (row.virtualMachine?.id === id) delete row.virtualMachine
    }
  } }
  p.networkClient = { networkInterfaces: {
    get: async (group, name) => get(nics, resourceId('Microsoft.Network/networkInterfaces', name, 'sub', group)),
    beginCreateOrUpdateAndWait: async (group, name, body, options) => {
      const id = resourceId('Microsoft.Network/networkInterfaces', name, 'sub', group)
      const current = nics.get(id)
      if (options) assert.equal(options.requestOptions.customHeaders['If-Match'], current.etag)
      const row = { ...structuredClone(body), id, name, etag: 'v2', provisioningState: 'Succeeded' }
      nics.set(id, row); syncAssociations(); writes.push({ kind: 'nic', body, options })
      return structuredClone(row)
    },
    beginDeleteAndWait: async (group, name) => {
      const id = resourceId('Microsoft.Network/networkInterfaces', name, 'sub', group)
      nics.delete(id); syncAssociations(); deleted.push(id)
    }
  }, publicIPAddresses: {
    get: async (group, name) => get(ips, resourceId('Microsoft.Network/publicIPAddresses', name, 'sub', group)),
    beginCreateOrUpdateAndWait: async (group, name, body) => {
      const ip = addIp({ ...body, name, id: resourceId('Microsoft.Network/publicIPAddresses', name, 'sub', group) })
      writes.push({ kind: 'ip', body }); return structuredClone(ip)
    },
    beginDeleteAndWait: async (group, name) => {
      const id = resourceId('Microsoft.Network/publicIPAddresses', name, 'sub', group)
      assert.equal(AzureProvider.normalizePublicIp(ips.get(id)).associated, false)
      ips.delete(id); deleted.push(id)
    }
  } }
  return { p, vm, nic, vms, nics, ips, writes, deleted, addIp, syncAssociations, setQuota: value => { quotaRemaining = value } }
}

test('public IP creation is opt-in and malformed options are rejected', () => {
  assert.equal(validateAzureFreeCreateParams({}).createPublicIp, false)
  assert.equal(validateAzureFreeCreateParams({ createPublicIp: true }).createPublicIp, true)
  assert.equal(validateAzureFreeCreateParams({ createPublicIp: 'false' }).createPublicIp, false)
  assert.throws(() => validateAzureFreeCreateParams({ createPublicIp: 'yes' }), { statusCode: 400 })
})

test('standalone IP creation returns an unused bindable address and retries do not allocate another paid IP', async () => {
  const { p, ips, writes, setQuota } = fixture()
  const params = { location: 'region', requestId: 'stable-standalone-request' }
  const created = await p.createPublicIp(params)
  assert.equal(created.canBind, true)
  assert.equal(created.associated, false)
  assert.equal(created.canDelete, true)
  assert.equal(created.region, 'region')
  assert.equal(created.sku, 'Standard')
  assert.equal(created.allocationMethod, 'Static')
  setQuota(0)
  assert.deepEqual(await p.createPublicIp(params), created)
  assert.equal(ips.size, 1)
  assert.deepEqual(writes.map(item => item.kind), ['ip'])
  await p.bindPublicIp(vmId, { mode: 'existing', publicIpId: created.id })
  const deletion = await p.deleteInstance(vmId)
  assert.equal(deletion.cleanup.complete, true)
  assert.equal(ips.size, 0)
})

test('standalone IP creation validates region, request ID, subscription and quota before allocation', async () => {
  const { p, writes, setQuota } = fixture()
  for (const params of [{}, { location: 'region' }, { location: '../region', requestId: 'stable-standalone-request' },
    { location: 'region', requestId: 'short' }]) {
    await assert.rejects(p.createPublicIp(params), { statusCode: 400 })
  }
  p.subscription.state = 'Disabled'
  await assert.rejects(p.createPublicIp({ location: 'region', requestId: 'stable-standalone-request' }), { code: 'FreeOnlyMode' })
  p.subscription.state = 'Enabled'
  setQuota(0)
  await assert.rejects(p.createPublicIp({ location: 'region', requestId: 'stable-standalone-request' }), { code: 'PublicIPCountLimitReached' })
  assert.equal(writes.length, 0)
})

test('standalone IP creation respects regional policy and requires a fresh request ID for another region', async () => {
  const { p, writes } = fixture()
  p._assertLocationAllowed = async () => { throw new Error('region blocked') }
  await assert.rejects(p.createPublicIp({ location: 'region', requestId: 'stable-standalone-request' }), /region blocked/)
  assert.equal(writes.length, 0)
  p._assertLocationAllowed = async () => {}
  await p.createPublicIp({ location: 'region', requestId: 'stable-standalone-request' })
  await assert.rejects(p.createPublicIp({ location: 'otherregion', requestId: 'stable-standalone-request' }), /无法复用/)
  assert.equal(writes.length, 1)
})

test('creation optionally provisions one Standard static IPv4 and retries reuse the VM and IP', async () => {
  const { p, vms, nics, writes } = fixture()
  vms.clear(); nics.clear()
  const params = { subscriptionId: 'sub', location: 'region', vmSize: 'Standard_B2ats_v2', adminPassword: 'Test-password123!', createPublicIp: true }
  const result = await p.createInstance(params, { creationId: 'stable-create' })
  assert.deepEqual(writes.map(item => item.kind), ['ip', 'nic', 'vm'])
  assert.deepEqual(writes[0].body.sku, { name: 'Standard', tier: 'Regional' })
  assert.equal(writes[0].body.publicIPAllocationMethod, 'Static')
  assert.equal(writes[0].body.publicIPAddressVersion, 'IPv4')
  assert.ok(writes[1].body.ipConfigurations[0].publicIPAddress.id.endsWith('-pip'))
  assert.equal(writes[1].body.ipConfigurations[0].publicIPAddress.deleteOption, 'Delete')
  assert.deepEqual(await p.createInstance(params, { creationId: 'stable-create' }), result)
  assert.equal(writes.length, 3)
})

test('a failed creation reuses its already allocated IP even when the remaining quota is zero', async () => {
  const { p, vms, nics, writes, setQuota } = fixture()
  vms.clear(); nics.clear()
  const createNic = p.networkClient.networkInterfaces.beginCreateOrUpdateAndWait
  p.networkClient.networkInterfaces.beginCreateOrUpdateAndWait = async () => { throw new Error('NIC failure') }
  const params = { subscriptionId: 'sub', location: 'region', vmSize: 'Standard_B2ats_v2', adminPassword: 'Test-password123!', createPublicIp: true }
  await assert.rejects(p.createInstance(params, { creationId: 'retry-create' }), /NIC failure/)
  setQuota(0)
  p.networkClient.networkInterfaces.beginCreateOrUpdateAndWait = createNic
  await p.createInstance(params, { creationId: 'retry-create' })
  assert.equal(writes.filter(item => item.kind === 'ip').length, 1)
})

test('binding an existing address preserves NIC settings and deletes that untagged IP with the VM', async () => {
  const { p, nic, nics, writes, deleted, addIp } = fixture()
  addIp()
  const result = await p.bindPublicIp(vmId, { mode: 'existing', publicIpId: ipId })
  assert.equal(result.ipAddress, '203.0.113.8')
  const updated = nics.get(nicId)
  assert.deepEqual(updated.dnsSettings, nic.dnsSettings)
  assert.equal(updated.enableIPForwarding, true)
  assert.deepEqual(updated.ipConfigurations[1], nic.ipConfigurations[1])
  assert.equal(updated.ipConfigurations[0].privateIPAddress, '10.0.0.4')
  assert.equal(writes[0].options.requestOptions.customHeaders['If-Match'], 'v1')
  await p.bindPublicIp(vmId, { mode: 'existing', publicIpId: ipId })
  assert.equal(writes.length, 1, 'repeated bind is idempotent')
  const cleanup = await p.deleteInstance(vmId)
  assert.equal(cleanup.cleanup.complete, true)
  assert.deepEqual(deleted, [vmId, nicId, ipId])
})

test('new IP binding honors VM zones, creates one address and is idempotent', async () => {
  const { p, vm, writes, ips } = fixture()
  vm.zones = ['2']
  const result = await p.bindPublicIp(vmId, { mode: 'new' })
  assert.deepEqual(writes[0].body.zones, ['2'])
  assert.equal(ips.size, 1)
  assert.deepEqual(await p.bindPublicIp(vmId, { mode: 'new' }), result)
  assert.equal(writes.length, 2)
})

test('quota exhaustion prevents a new paid IP from being allocated or attached', async () => {
  const { p, setQuota, writes } = fixture()
  setQuota(0)
  await assert.rejects(p.bindPublicIp(vmId, { mode: 'new' }), { code: 'PublicIPCountLimitReached' })
  assert.equal(writes.length, 0)
})

test('binding rejects occupied, incompatible, foreign and malformed addresses without updating the NIC', async () => {
  for (const overrides of [{ ipConfiguration: { id: 'another-nic' } }, { natGateway: { id: 'nat' } },
    { sku: { name: 'Basic' } }, { sku: { name: 'Standard', tier: 'Global' } }, { publicIPAddressVersion: 'IPv6' },
    { publicIPAllocationMethod: 'Dynamic' }, { location: 'other-region' }, { provisioningState: 'Updating' }, { zones: ['3'] }]) {
    const { p, vm, writes, addIp } = fixture()
    vm.zones = ['2']; addIp(overrides)
    await assert.rejects(p.bindPublicIp(vmId, { mode: 'existing', publicIpId: ipId }))
    assert.equal(writes.length, 0)
  }
  const { p, writes } = fixture()
  await assert.rejects(p.bindPublicIp(vmId, { mode: 'existing', publicIpId: ipId.replace('/sub/', '/foreign/') }), { statusCode: 400 })
  await assert.rejects(p.bindPublicIp(vmId, { mode: 'existing' }), { statusCode: 400 })
  await assert.rejects(p.bindPublicIp(vmId, { mode: 'replace' }), { statusCode: 400 })
  await assert.rejects(p.bindPublicIp(vmId), { statusCode: 400 })
  assert.equal(writes.length, 0)
})

test('an existing public IP is never silently replaced and stale or foreign NICs are rejected', async () => {
  const { p, nic, writes } = fixture()
  nic.ipConfigurations[0].publicIPAddress = { id: ipId }
  await assert.rejects(p.bindPublicIp(vmId, { mode: 'new' }), { statusCode: 409 })
  delete nic.ipConfigurations[0].publicIPAddress
  nic.virtualMachine.id = 'another-vm'
  await assert.rejects(p.bindPublicIp(vmId, { mode: 'new' }), { statusCode: 409 })
  nic.virtualMachine.id = vmId
  delete nic.etag
  await assert.rejects(p.bindPublicIp(vmId, { mode: 'new' }), { statusCode: 409 })
  assert.equal(writes.length, 0)
})

test('lost bind responses are reconciled and failed binds reuse the retained IP on retry', async () => {
  for (const applied of [false, true]) {
    const { p, ips, writes } = fixture()
    const updateNic = p.networkClient.networkInterfaces.beginCreateOrUpdateAndWait
    p.networkClient.networkInterfaces.beginCreateOrUpdateAndWait = async (...args) => {
      if (applied) await updateNic(...args)
      throw new Error('lost response')
    }
    if (applied) await p.bindPublicIp(vmId, { mode: 'new' })
    else await assert.rejects(p.bindPublicIp(vmId, { mode: 'new' }), /已保留/)
    assert.equal(ips.size, 1)
    p.networkClient.networkInterfaces.beginCreateOrUpdateAndWait = updateNic
    await p.bindPublicIp(vmId, { mode: 'new' })
    assert.equal(writes.filter(item => item.kind === 'ip').length, 1)
  }
})

test('deletion detaches and deletes bound IPs while preserving an external NIC', async () => {
  const { p, vm, nic, nics, ips, deleted, addIp, syncAssociations } = fixture()
  vm.tags = {}; vm.networkProfile.networkInterfaces[0].deleteOption = 'Detach'; nic.tags = {}
  addIp(); nic.ipConfigurations[0].publicIPAddress = { id: ipId }; syncAssociations()
  const result = await p.deleteInstance(vmId)
  assert.equal(nics.has(nicId), true)
  assert.equal(ips.size, 0)
  assert.deepEqual(deleted, [vmId, ipId])
  assert.deepEqual(result.cleanup.retained.map(item => item.id), [nicId])
  assert.equal(result.cleanup.failed.length, 0)
})

test('deletion retains an IP reassigned to a different resource and reports its cleanup failure', async () => {
  const { p, nic, ips, addIp } = fixture()
  addIp({ natGateway: { id: 'new-owner' } })
  nic.ipConfigurations[0].publicIPAddress = { id: ipId }
  p.networkClient.networkInterfaces.beginDeleteAndWait = async () => {}
  const result = await p.deleteInstance(vmId)
  assert.equal(ips.size, 1)
  assert.ok(result.cleanup.failed.some(item => item.id === ipId))
})

test('IP cleanup never detaches a different unused NIC after reassignment', async () => {
  const { p, nic, writes, ips, addIp, syncAssociations } = fixture()
  delete nic.virtualMachine
  addIp(); nic.ipConfigurations[0].publicIPAddress = { id: ipId }; syncAssociations()
  await assert.rejects(p.deletePublicIp(ipId, { detachUnusedNic: true, expectedNicId: nicId + '-original' }), { statusCode: 409 })
  assert.equal(writes.length, 0)
  assert.equal(ips.size, 1)
})
