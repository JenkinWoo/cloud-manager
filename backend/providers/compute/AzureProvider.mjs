import axios from 'axios'
import BaseComputeProvider from './BaseComputeProvider.mjs'
import { normalizeAzureCredentials } from '../../utils/azureCredentials.mjs'

let azureSdkPromise = null

function safeName(input, fallback = 'cloud-manager') {
  const cleaned = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return (cleaned || fallback).slice(0, 50)
}

function randomSuffix(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length)
}

function parseAzureResourceId(id = '') {
  const parts = String(id).split('/').filter(Boolean)
  const mapped = {}

  for (let i = 0; i < parts.length - 1; i += 2) {
    mapped[parts[i].toLowerCase()] = parts[i + 1]
  }

  return {
    subscriptionId: mapped.subscriptions || '',
    resourceGroup: mapped.resourcegroups || '',
    provider: mapped.providers || '',
    resourceName: parts[parts.length - 1] || '',
    resourceType: parts[parts.length - 2] || '',
    parts
  }
}

function mapPowerState(statuses = []) {
  const powerStatus = statuses.find((item) => item.code?.startsWith('PowerState/'))?.code?.split('/')[1]
  const provisioningStatus = statuses.find((item) => item.code?.startsWith('ProvisioningState/'))?.code?.split('/')[1]

  const stateMap = {
    running: 'RUNNING',
    starting: 'STARTING',
    stopped: 'STOPPED',
    stopping: 'STOPPING',
    deallocated: 'STOPPED',
    deallocating: 'STOPPING',
    unknown: 'UNKNOWN'
  }

  if (powerStatus) return stateMap[powerStatus.toLowerCase()] || powerStatus.toUpperCase()
  if (provisioningStatus) return provisioningStatus.toUpperCase()
  return 'UNKNOWN'
}

function capabilityValue(sku, key) {
  return sku.capabilities?.find((item) => item.name === key)?.value || ''
}

function isStudentFreeSubscription(subscription = {}) {
  const name = String(subscription.displayName || '').toLowerCase()
  const quotaId = String(subscription.subscriptionPolicies?.quotaId || '').toLowerCase()
  const spendingLimit = String(subscription.subscriptionPolicies?.spendingLimit || '').toLowerCase()
  const text = `${name} ${quotaId} ${spendingLimit}`

  return (
    text.includes('student') ||
    text.includes('students') ||
    text.includes('free') ||
    text.includes('trial') ||
    text.includes('azure for students') ||
    quotaId.includes('student') ||
    quotaId.includes('free') ||
    quotaId.includes('trial') ||
    spendingLimit === 'on'
  )
}

async function loadAzureSdk() {
  if (!azureSdkPromise) {
    azureSdkPromise = Promise.all([
      import('@azure/identity'),
      import('@azure/arm-compute'),
      import('@azure/arm-network'),
      import('@azure/arm-resources')
    ]).then(([identityMod, computeMod, networkMod, resourcesMod]) => ({
      ClientSecretCredential: identityMod.ClientSecretCredential,
      ComputeManagementClient: computeMod.ComputeManagementClient,
      NetworkManagementClient: networkMod.NetworkManagementClient,
      ResourceManagementClient: resourcesMod.ResourceManagementClient
    }))
  }

  return azureSdkPromise
}

export default class AzureProvider extends BaseComputeProvider {
  static providerName = 'azure'
  static capabilities = ['switch_ip', 'allow_all_inbound_traffic']

  constructor(account) {
    super(account)
    this.accountName = account.name || 'azure'
    this.credentials = normalizeAzureCredentials(account.credentials || {})
    this.credential = null
    this.subscriptionId = null
    this.subscriptionName = null
    this.computeClient = null
    this.networkClient = null
    this.resourceClient = null
    this.selectedSubscriptionId = null
    this._sdk = null
    this._credentialPromise = null
    this._initPromise = null
  }

  useSubscription(subscriptionId) {
    const nextSubscriptionId = subscriptionId || null
    if (this.selectedSubscriptionId !== nextSubscriptionId) {
      this.selectedSubscriptionId = nextSubscriptionId
      this.subscriptionId = null
      this.subscriptionName = null
      this.computeClient = null
      this.networkClient = null
      this.resourceClient = null
      this._initPromise = null
    }
    return this
  }

  async _loadSdk() {
    if (!this._sdk) {
      this._sdk = await loadAzureSdk()
    }
    return this._sdk
  }

  async _ensureCredential() {
    if (this.credential) return this.credential
    if (this._credentialPromise) return this._credentialPromise

    this._credentialPromise = (async () => {
      const { ClientSecretCredential } = await this._loadSdk()
      this.credential = new ClientSecretCredential(
        this.credentials.tenant,
        this.credentials.appId,
        this.credentials.password
      )
      return this.credential
    })()

    return this._credentialPromise
  }

  async _armGet(path, apiVersion = '2022-12-01') {
    await this._ensureCredential()
    const token = await this.credential.getToken('https://management.azure.com/.default')
    if (!token?.token) {
      throw new Error('无法获取 Azure 管理 API 访问令牌')
    }

    const url = `https://management.azure.com${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token.token}`
      }
    })
    return response.data
  }

  async _listSubscriptions() {
    const response = await this._armGet('/subscriptions', '2020-01-01')
    return Array.isArray(response?.value) ? response.value : []
  }

  async listEligibleSubscriptions() {
    const subscriptions = await this._listSubscriptions()
    return subscriptions
      .filter((item) => String(item.state || '').toLowerCase() === 'enabled')
      .filter((item) => isStudentFreeSubscription(item))
      .map((item) => ({
        subscriptionId: item.subscriptionId,
        displayName: item.displayName || item.subscriptionId,
        quotaId: item.subscriptionPolicies?.quotaId || '',
        spendingLimit: item.subscriptionPolicies?.spendingLimit || ''
      }))
  }

  async _resolveSubscription(requestedSubscriptionId = this.selectedSubscriptionId) {
    const subscriptions = await this._listSubscriptions()
    const enabledSubscriptions = subscriptions.filter((item) => String(item.state || '').toLowerCase() === 'enabled')

    if (requestedSubscriptionId) {
      const selected = enabledSubscriptions.find((item) => item.subscriptionId === requestedSubscriptionId)
      if (!selected) {
        throw new Error('所选 Azure 订阅不可用或当前账号无权限访问')
      }
      return selected
    }

    const preferred = enabledSubscriptions.find((item) => isStudentFreeSubscription(item))
    if (preferred) return preferred

    const firstEnabled = enabledSubscriptions[0]
    if (!firstEnabled) {
      throw new Error('当前 Azure 服务主体没有可用订阅，请确认已给该 appId 分配订阅权限')
    }

    return firstEnabled
  }

  async _ensureInitialized() {
    if (this._initPromise) {
      await this._initPromise
      return
    }

    this._initPromise = (async () => {
      const { ComputeManagementClient, NetworkManagementClient, ResourceManagementClient } = await this._loadSdk()
      await this._ensureCredential()

      const subscription = await this._resolveSubscription()
      this.subscriptionId = subscription.subscriptionId
      this.subscriptionName = subscription.displayName || subscription.subscriptionId

      this.computeClient = new ComputeManagementClient(this.credential, this.subscriptionId)
      this.networkClient = new NetworkManagementClient(this.credential, this.subscriptionId)
      this.resourceClient = new ResourceManagementClient(this.credential, this.subscriptionId)
    })()

    try {
      await this._initPromise
    } catch (error) {
      this._initPromise = null
      throw error
    }
  }

  async listLocations(subscriptionId) {
    const subscription = await this._resolveSubscription(subscriptionId)
    const response = await this._armGet(`/subscriptions/${subscription.subscriptionId}/locations`, '2022-12-01')
    const locations = Array.isArray(response?.value) ? response.value : []

    return locations
      .map((item) => ({
        name: item.name,
        displayName: item.displayName || item.name,
        regionalDisplayName: item.regionalDisplayName || item.displayName || item.name
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  async listVmSizes(location, subscriptionId) {
    if (!location) {
      throw new Error('Azure VM Size 查询需要 location')
    }

    const { ComputeManagementClient } = await this._loadSdk()
    await this._ensureCredential()

    const subscription = await this._resolveSubscription(subscriptionId)
    const client = new ComputeManagementClient(this.credential, subscription.subscriptionId)
    const sizes = []

    for await (const item of client.virtualMachineSizes.list(location)) {
      sizes.push({
        name: item.name,
        numberOfCores: item.numberOfCores,
        memoryInMB: item.memoryInMB,
        osDiskSizeInMB: item.osDiskSizeInMB,
        resourceDiskSizeInMB: item.resourceDiskSizeInMB,
        maxDataDiskCount: item.maxDataDiskCount,
        label: `${item.name} · ${item.numberOfCores || 0} vCPU · ${((item.memoryInMB || 0) / 1024).toFixed(1)} GB`
      })
    }

    return sizes.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }

  _defaultResourceGroupName() {
    return safeName(`cloud-manager-${this.accountName}`, 'cloud-manager-azure')
  }

  _resourceNames(location) {
    const suffix = safeName(location || 'default', 'default')
    return {
      resourceGroupName: this._defaultResourceGroupName(),
      virtualNetworkName: `cm-vnet-${suffix}`,
      subnetName: 'default',
      networkSecurityGroupName: `cm-nsg-${suffix}`
    }
  }

  async _ensureResourceGroup(resourceGroupName, location) {
    await this._ensureInitialized()
    return this.resourceClient.resourceGroups.createOrUpdate(resourceGroupName, {
      location,
      tags: { managedBy: 'cloud-manager' }
    })
  }

  async _ensureNetworkSecurityGroup(resourceGroupName, location, networkSecurityGroupName) {
    await this._ensureInitialized()

    try {
      return await this.networkClient.networkSecurityGroups.get(resourceGroupName, networkSecurityGroupName)
    } catch (_) {
    }

    return this.networkClient.networkSecurityGroups.beginCreateOrUpdateAndWait(resourceGroupName, networkSecurityGroupName, {
      location,
      tags: { managedBy: 'cloud-manager' },
      securityRules: [
        {
          name: 'allow-ssh',
          access: 'Allow',
          direction: 'Inbound',
          priority: 1000,
          protocol: 'Tcp',
          sourcePortRange: '*',
          destinationPortRange: '22',
          sourceAddressPrefix: '*',
          destinationAddressPrefix: '*'
        }
      ]
    })
  }

  async _ensureVirtualNetwork(resourceGroupName, location, virtualNetworkName) {
    await this._ensureInitialized()

    try {
      return await this.networkClient.virtualNetworks.get(resourceGroupName, virtualNetworkName)
    } catch (_) {
    }

    return this.networkClient.virtualNetworks.beginCreateOrUpdateAndWait(resourceGroupName, virtualNetworkName, {
      location,
      tags: { managedBy: 'cloud-manager' },
      addressSpace: {
        addressPrefixes: ['10.30.0.0/16']
      }
    })
  }

  async _ensureSubnet(resourceGroupName, virtualNetworkName, subnetName, networkSecurityGroupId) {
    await this._ensureInitialized()

    try {
      const subnet = await this.networkClient.subnets.get(resourceGroupName, virtualNetworkName, subnetName)
      if (networkSecurityGroupId && subnet.networkSecurityGroup?.id !== networkSecurityGroupId) {
        return this.networkClient.subnets.beginCreateOrUpdateAndWait(resourceGroupName, virtualNetworkName, subnetName, {
          addressPrefix: subnet.addressPrefix || '10.30.1.0/24',
          networkSecurityGroup: { id: networkSecurityGroupId }
        })
      }
      return subnet
    } catch (_) {
    }

    return this.networkClient.subnets.beginCreateOrUpdateAndWait(resourceGroupName, virtualNetworkName, subnetName, {
      addressPrefix: '10.30.1.0/24',
      networkSecurityGroup: networkSecurityGroupId ? { id: networkSecurityGroupId } : undefined
    })
  }

  async _ensureDefaultNetwork(location) {
    const names = this._resourceNames(location)

    await this._ensureResourceGroup(names.resourceGroupName, location)
    const nsg = await this._ensureNetworkSecurityGroup(names.resourceGroupName, location, names.networkSecurityGroupName)
    await this._ensureVirtualNetwork(names.resourceGroupName, location, names.virtualNetworkName)
    const subnet = await this._ensureSubnet(names.resourceGroupName, names.virtualNetworkName, names.subnetName, nsg.id)

    return {
      ...names,
      subnet,
      networkSecurityGroup: nsg
    }
  }

  async _getNicById(id) {
    const { resourceGroup, resourceName } = parseAzureResourceId(id)
    if (!resourceGroup || !resourceName) {
      throw new Error(`无法解析 Azure 网卡资源 ID: ${id}`)
    }
    return this.networkClient.networkInterfaces.get(resourceGroup, resourceName)
  }

  async _getPublicIpById(id) {
    const { resourceGroup, resourceName } = parseAzureResourceId(id)
    if (!resourceGroup || !resourceName) {
      throw new Error(`无法解析 Azure 公网 IP 资源 ID: ${id}`)
    }
    return this.networkClient.publicIPAddresses.get(resourceGroup, resourceName)
  }

  async _collectVmNetworkDetails(vm) {
    const publicIps = []
    const privateIps = []
    const ipv6Addresses = []

    for (const nicRef of vm.networkProfile?.networkInterfaces || []) {
      if (!nicRef.id) continue
      const nic = await this._getNicById(nicRef.id)

      for (const config of nic.ipConfigurations || []) {
        if (config.privateIPAddress) {
          if (String(config.privateIPAddressVersion || 'IPv4').toUpperCase() === 'IPV6') ipv6Addresses.push(config.privateIPAddress)
          else privateIps.push(config.privateIPAddress)
        }

        if (config.publicIPAddress?.id) {
          try {
            const publicIp = await this._getPublicIpById(config.publicIPAddress.id)
            if (publicIp.ipAddress) {
              if (String(publicIp.publicIPAddressVersion || 'IPv4').toUpperCase() === 'IPV6') ipv6Addresses.push(publicIp.ipAddress)
              else publicIps.push(publicIp.ipAddress)
            }
          } catch (_) {
          }
        }
      }
    }

    return { publicIps, privateIps, ipv6Addresses }
  }

  async listInstances() {
    await this._ensureInitialized()
    const vms = []

    for await (const vm of this.computeClient.virtualMachines.listAll()) {
      vms.push(vm)
    }

    return Promise.all(vms.map(async (vm) => {
      const parsed = parseAzureResourceId(vm.id)
      let instanceView = null
      let networkDetails = { publicIps: [], privateIps: [], ipv6Addresses: [] }

      try {
        instanceView = await this.computeClient.virtualMachines.instanceView(parsed.resourceGroup, vm.name)
      } catch (_) {
      }

      try {
        networkDetails = await this._collectVmNetworkDetails(vm)
      } catch (_) {
      }

      return AzureProvider.normalizeInstance(vm, {
        state: mapPowerState(instanceView?.statuses),
        publicIps: networkDetails.publicIps,
        privateIps: networkDetails.privateIps,
        ipv6Addresses: networkDetails.ipv6Addresses
      })
    }))
  }

  async getInstance(instanceId) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    if (!parsed.resourceGroup || !parsed.resourceName) {
      throw new Error(`无法识别 Azure 实例 ID: ${instanceId}`)
    }

    const vm = await this.computeClient.virtualMachines.get(parsed.resourceGroup, parsed.resourceName)
    const instanceView = await this.computeClient.virtualMachines.instanceView(parsed.resourceGroup, parsed.resourceName)
    const networkDetails = await this._collectVmNetworkDetails(vm)

    return AzureProvider.normalizeInstance(vm, {
      state: mapPowerState(instanceView?.statuses),
      publicIps: networkDetails.publicIps,
      privateIps: networkDetails.privateIps,
      ipv6Addresses: networkDetails.ipv6Addresses
    })
  }

  async createInstance(params) {
    this.useSubscription(params.subscriptionId)
    await this._ensureInitialized()

    const location = params.location || 'eastasia'
    const vmSize = params.vmSize || 'Standard_B1s'
    const adminUsername = params.adminUsername || 'azureuser'
    const adminPassword = params.adminPassword

    if (!adminPassword) {
      throw new Error('Azure 实例创建需要 adminPassword')
    }

    const imagePublisher = params.imagePublisher || 'Canonical'
    const imageOffer = params.imageOffer || '0001-com-ubuntu-server-jammy'
    const imageSku = params.imageSku || '22_04-lts-gen2'
    const imageVersion = params.imageVersion || 'latest'

    const network = await this._ensureDefaultNetwork(location)
    const vmName = safeName(`cm-${this.accountName}-${randomSuffix(8)}`, `cm-vm-${randomSuffix(6)}`)
    const publicIpName = `${vmName}-pip`
    const nicName = `${vmName}-nic`

    const publicIp = await this.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(network.resourceGroupName, publicIpName, {
      location,
      publicIPAllocationMethod: 'Static',
      publicIPAddressVersion: 'IPv4',
      sku: { name: 'Standard' },
      tags: { managedBy: 'cloud-manager', vmName }
    })

    const nic = await this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(network.resourceGroupName, nicName, {
      location,
      tags: { managedBy: 'cloud-manager', vmName },
      networkSecurityGroup: network.networkSecurityGroup?.id ? { id: network.networkSecurityGroup.id } : undefined,
      ipConfigurations: [
        {
          name: 'ipconfig1',
          subnet: { id: network.subnet.id },
          privateIPAllocationMethod: 'Dynamic',
          publicIPAddress: { id: publicIp.id },
          primary: true
        }
      ]
    })

    const vm = await this.computeClient.virtualMachines.beginCreateOrUpdateAndWait(network.resourceGroupName, vmName, {
      location,
      tags: { managedBy: 'cloud-manager' },
      hardwareProfile: { vmSize },
      osProfile: {
        computerName: vmName,
        adminUsername,
        adminPassword,
        linuxConfiguration: {
          disablePasswordAuthentication: false
        }
      },
      storageProfile: {
        imageReference: {
          publisher: imagePublisher,
          offer: imageOffer,
          sku: imageSku,
          version: imageVersion
        },
        osDisk: {
          createOption: 'FromImage',
          deleteOption: 'Delete',
          managedDisk: {
            storageAccountType: 'Standard_LRS'
          }
        }
      },
      networkProfile: {
        networkInterfaces: [
          {
            id: nic.id,
            primary: true,
            deleteOption: 'Delete'
          }
        ]
      }
    })

    return {
      instanceId: vm.id,
      displayName: vm.name || vmName
    }
  }

  async deleteInstance(instanceId) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    if (!parsed.resourceGroup || !parsed.resourceName) {
      throw new Error(`无法识别 Azure 实例 ID: ${instanceId}`)
    }

    await this.computeClient.virtualMachines.beginDeleteAndWait(parsed.resourceGroup, parsed.resourceName)
    return { instanceId }
  }

  async instanceAction(instanceId, action) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    if (!parsed.resourceGroup || !parsed.resourceName) {
      throw new Error(`无法识别 Azure 实例 ID: ${instanceId}`)
    }

    switch (action) {
      case 'START':
        await this.computeClient.virtualMachines.beginStartAndWait(parsed.resourceGroup, parsed.resourceName)
        break
      case 'STOP':
        await this.computeClient.virtualMachines.beginPowerOffAndWait(parsed.resourceGroup, parsed.resourceName)
        break
      case 'REBOOT':
      case 'HARD_REBOOT':
        await this.computeClient.virtualMachines.beginRestartAndWait(parsed.resourceGroup, parsed.resourceName)
        break
      default:
        throw new Error(`Azure 不支持的实例操作: ${action}`)
    }

    return { instanceId, action }
  }

  async _updateNic(nic) {
    const parsed = parseAzureResourceId(nic.id)
    return this.networkClient.networkInterfaces.beginCreateOrUpdateAndWait(parsed.resourceGroup, parsed.resourceName, {
      location: nic.location,
      tags: nic.tags,
      enableAcceleratedNetworking: nic.enableAcceleratedNetworking,
      enableIPForwarding: nic.enableIPForwarding,
      networkSecurityGroup: nic.networkSecurityGroup,
      dnsSettings: nic.dnsSettings,
      ipConfigurations: (nic.ipConfigurations || []).map((config) => ({
        name: config.name,
        privateIPAddress: config.privateIPAddress,
        privateIPAllocationMethod: config.privateIPAllocationMethod,
        privateIPAddressVersion: config.privateIPAddressVersion,
        subnet: config.subnet,
        publicIPAddress: config.publicIPAddress,
        primary: config.primary
      }))
    })
  }

  async switchPublicIp(instanceId) {
    await this._ensureInitialized()
    const vm = await this.getInstance(instanceId)
    const rawVm = vm.raw
    const primaryNicRef = rawVm.networkProfile?.networkInterfaces?.find((item) => item.primary) || rawVm.networkProfile?.networkInterfaces?.[0]

    if (!primaryNicRef?.id) {
      throw new Error('Azure 实例未绑定网卡，无法切换公网 IP')
    }

    const nic = await this._getNicById(primaryNicRef.id)
    const ipConfig = nic.ipConfigurations?.find((item) => item.primary) || nic.ipConfigurations?.[0]
    if (!ipConfig) {
      throw new Error('Azure 网卡缺少 IP 配置')
    }

    const oldPublicIpId = ipConfig.publicIPAddress?.id || ''
    const oldPublicIp = oldPublicIpId ? await this._getPublicIpById(oldPublicIpId).catch(() => null) : null
    const publicIpParsed = oldPublicIpId ? parseAzureResourceId(oldPublicIpId) : parseAzureResourceId(nic.id)
    const nicParsed = parseAzureResourceId(nic.id)
    const publicIpName = `${safeName(rawVm.name || nic.name || 'vm')}-pip-${randomSuffix(5)}`

    const newPublicIp = await this.networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(
      publicIpParsed.resourceGroup || nicParsed.resourceGroup,
      publicIpName,
      {
        location: nic.location || rawVm.location,
        publicIPAllocationMethod: 'Static',
        publicIPAddressVersion: 'IPv4',
        sku: { name: 'Standard' },
        tags: { managedBy: 'cloud-manager', rotatedFrom: oldPublicIp?.name || '' }
      }
    )

    ipConfig.publicIPAddress = { id: newPublicIp.id }
    await this._updateNic(nic)

    if (oldPublicIp?.id) {
      const oldParsed = parseAzureResourceId(oldPublicIp.id)
      try {
        await this.networkClient.publicIPAddresses.beginDeleteAndWait(oldParsed.resourceGroup, oldParsed.resourceName)
      } catch (_) {
      }
    }

    return {
      newIp: newPublicIp.ipAddress,
      oldIp: oldPublicIp?.ipAddress || null
    }
  }

  async allowAllInboundTraffic(instanceId) {
    await this._ensureInitialized()
    const parsed = parseAzureResourceId(instanceId)
    const vm = await this.computeClient.virtualMachines.get(parsed.resourceGroup, parsed.resourceName)
    const primaryNicRef = vm.networkProfile?.networkInterfaces?.find((item) => item.primary) || vm.networkProfile?.networkInterfaces?.[0]

    if (!primaryNicRef?.id) {
      throw new Error('Azure 实例未绑定网卡，无法配置防火墙')
    }

    const nic = await this._getNicById(primaryNicRef.id)
    const nicParsed = parseAzureResourceId(nic.id)
    let nsgRef = nic.networkSecurityGroup

    if (!nsgRef?.id) {
      const nsg = await this._ensureNetworkSecurityGroup(
        nicParsed.resourceGroup,
        vm.location || 'eastasia',
        `${safeName(nic.name || vm.name || 'azure-vm')}-nsg`
      )
      nic.networkSecurityGroup = { id: nsg.id }
      await this._updateNic(nic)
      nsgRef = { id: nsg.id }
    }

    const nsgParsed = parseAzureResourceId(nsgRef.id)
    const nsg = await this.networkClient.networkSecurityGroups.get(nsgParsed.resourceGroup, nsgParsed.resourceName)
    const existingRules = Array.isArray(nsg.securityRules) ? nsg.securityRules : []
    const ruleName = 'cloud-manager-allow-all-inbound'
    const filteredRules = existingRules.filter((item) => item.name !== ruleName)

    filteredRules.push({
      name: ruleName,
      access: 'Allow',
      direction: 'Inbound',
      priority: 100,
      protocol: '*',
      sourcePortRange: '*',
      destinationPortRange: '*',
      sourceAddressPrefix: '*',
      destinationAddressPrefix: '*'
    })

    await this.networkClient.networkSecurityGroups.beginCreateOrUpdateAndWait(nsgParsed.resourceGroup, nsgParsed.resourceName, {
      location: nsg.location || vm.location,
      tags: nsg.tags,
      securityRules: filteredRules
    })

    return { success: true }
  }

  static normalizeInstance(raw, details = {}) {
    return {
      id: raw.id,
      displayName: raw.name,
      state: details.state || raw.provisioningState || 'UNKNOWN',
      publicIps: details.publicIps || [],
      privateIps: details.privateIps || [],
      ipv6Addresses: details.ipv6Addresses || [],
      region: raw.location,
      zone: raw.zones?.[0] || raw.location,
      shape: raw.hardwareProfile?.vmSize,
      cpu: Number(capabilityValue(raw, 'vCPUs')) || null,
      memoryGb: Number(capabilityValue(raw, 'MemoryGB')) || null,
      provider: 'azure',
      timeCreated: raw.timeCreated || raw.properties?.timeCreated || null,
      raw
    }
  }
}
