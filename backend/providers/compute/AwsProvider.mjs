import {
  EC2Client,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  DescribeAddressesCommand,
  AllocateAddressCommand,
  AssociateAddressCommand,
  AssignIpv6AddressesCommand,
  ReleaseAddressCommand,
  DescribeImagesCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeKeyPairsCommand,
  UnassignIpv6AddressesCommand
} from '@aws-sdk/client-ec2'
import BaseComputeProvider from './BaseComputeProvider.mjs'

export default class AwsProvider extends BaseComputeProvider {
  static providerName = 'aws'
  static capabilities = ['elastic_ip', 'switch_ip', 'switch_ipv6', 'security_groups', 'allow_all_inbound_traffic']

  constructor(account) {
    super(account)
    const { accessKeyId, secretAccessKey, region = 'ap-southeast-1' } = account.credentials || {}
    this.client = new EC2Client({
      region,
      credentials: { accessKeyId, secretAccessKey }
    })
    this.region = region
  }

  async listInstances() {
    const data = await this.client.send(new DescribeInstancesCommand({}))
    return data.Reservations.flatMap(r =>
      r.Instances.map(i => AwsProvider.normalizeInstance(i, this.region))
    )
  }

  async getInstance(instanceId) {
    const data = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
    const ins = data.Reservations?.[0]?.Instances?.[0]
    if (!ins) throw new Error('实例不存在: ' + instanceId)
    return AwsProvider.normalizeInstance(ins, this.region)
  }

  async createInstance(params) {
    const { instanceType = 't2.micro', imageId, rootPassword = 'Admin@123@q' } = params

    let finalImageId = imageId
    if (!finalImageId) {
      const imgCmd = new DescribeImagesCommand({
        Owners: ['amazon'],
        Filters: [
          { Name: 'name', Values: ['amzn2-ami-hvm-*-x86_64-gp2'] },
          { Name: 'state', Values: ['available'] }
        ]
      })
      const imgRes = await this.client.send(imgCmd)
      const sorted = imgRes.Images.sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate))
      if (!sorted.length) throw new Error('未找到可用 AMI')
      finalImageId = sorted[0].ImageId
    }

    const userDataScript = `#!/bin/bash\necho "ec2-user:${rootPassword}" | chpasswd\nsed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config\nsystemctl restart sshd`

    const res = await this.client.send(new RunInstancesCommand({
      ImageId: finalImageId,
      InstanceType: instanceType,
      UserData: Buffer.from(userDataScript).toString('base64'),
      MinCount: 1, MaxCount: 1
    }))

    const ins = res.Instances[0]
    return { instanceId: ins.InstanceId, displayName: ins.InstanceId }
  }

  async deleteInstance(instanceId) {
    await this.client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
    return { instanceId }
  }

  async instanceAction(instanceId, action) {
    switch (action) {
      case 'START':
        await this.client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }))
        break
      case 'STOP':
        await this.client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }))
        break
      case 'REBOOT':
      case 'HARD_REBOOT':
        await this.client.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }))
        break
      default:
        throw new Error('不支持的操作: ' + action)
    }
    return { instanceId, action }
  }

  _resolveSwitchIpTypes(options = {}) {
    const ipTypes = Array.isArray(options.ipTypes) && options.ipTypes.length ? options.ipTypes : ['ipv4']
    return {
      switchIpv4: ipTypes.includes('ipv4'),
      switchIpv6: ipTypes.includes('ipv6')
    }
  }

  _getPrimaryNetworkInterface(instance) {
    const interfaces = instance.NetworkInterfaces || []
    return interfaces.find((item) => item.Attachment?.DeviceIndex === 0) || interfaces[0] || null
  }

  async _switchIpv4(instanceId, instance = null) {
    // Find the current elastic IP associated to the instance
    const addrs = await this.client.send(new DescribeAddressesCommand({}))
    const oldAddr = addrs.Addresses.find(a => a.InstanceId === instanceId)
    const oldIpv4 = oldAddr?.PublicIp || instance?.PublicIpAddress || null

    // Allocate new
    const alloc = await this.client.send(new AllocateAddressCommand({ Domain: 'vpc' }))
    const newAllocationId = alloc.AllocationId
    const newPublicIp = alloc.PublicIp

    // Associate
    await this.client.send(new AssociateAddressCommand({ InstanceId: instanceId, AllocationId: newAllocationId }))

    // Release old
    if (oldAddr?.AllocationId) {
      await this.client.send(new ReleaseAddressCommand({ AllocationId: oldAddr.AllocationId }))
    }

    return { newIpv4: newPublicIp, oldIpv4 }
  }

  async _switchIpv6(instance) {
    const networkInterface = this._getPrimaryNetworkInterface(instance)
    if (!networkInterface?.NetworkInterfaceId) {
      throw new Error('AWS 实例未绑定网卡，无法切换 IPv6')
    }

    const oldIpv6s = (networkInterface.Ipv6Addresses || [])
      .map((item) => item.Ipv6Address)
      .filter(Boolean)

    const assigned = await this.client.send(new AssignIpv6AddressesCommand({
      NetworkInterfaceId: networkInterface.NetworkInterfaceId,
      Ipv6AddressCount: 1
    }))
    const newIpv6 = assigned.AssignedIpv6Addresses?.[0]
    if (!newIpv6) {
      throw new Error('AWS 未返回新的 IPv6 地址')
    }

    if (oldIpv6s.length) {
      await this.client.send(new UnassignIpv6AddressesCommand({
        NetworkInterfaceId: networkInterface.NetworkInterfaceId,
        Ipv6Addresses: oldIpv6s
      }))
    }

    return {
      newIpv6,
      oldIpv6: oldIpv6s[0] || null,
      oldIpv6s
    }
  }

  async switchPublicIp(instanceId, options = {}) {
    const { switchIpv4, switchIpv6 } = this._resolveSwitchIpTypes(options)
    const instance = await this.getInstance(instanceId)
    const rawInstance = instance.raw
    const result = { switchedTypes: [] }

    if (switchIpv4) {
      Object.assign(result, await this._switchIpv4(instanceId, rawInstance))
      result.switchedTypes.push('ipv4')
    }

    if (switchIpv6) {
      Object.assign(result, await this._switchIpv6(rawInstance))
      result.switchedTypes.push('ipv6')
    }

    return {
      ...result,
      newIp: result.newIpv4 || result.newIpv6 || null,
      oldIp: result.oldIpv4 || result.oldIpv6 || null
    }
  }

  async listElasticIps() {
    const data = await this.client.send(new DescribeAddressesCommand({}))
    return data.Addresses.map(a => ({
      allocationId: a.AllocationId,
      publicIp: a.PublicIp,
      instanceId: a.InstanceId || null,
      associated: !!a.InstanceId
    }))
  }

  async releaseUnusedElasticIps() {
    const data = await this.client.send(new DescribeAddressesCommand({}))
    const unassociated = data.Addresses.filter(a => !a.InstanceId)
    const results = []
    for (const ip of unassociated) {
      try {
        await this.client.send(new ReleaseAddressCommand({ AllocationId: ip.AllocationId }))
        results.push({ ip: ip.PublicIp, success: true })
      } catch (e) {
        results.push({ ip: ip.PublicIp, success: false, error: e.message })
      }
    }
    return results
  }

  async allowAllInboundTraffic(instanceId) {
    const data = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
    const ins = data.Reservations?.[0]?.Instances?.[0]
    if (!ins) throw new Error('实例不存在: ' + instanceId)
    const sgIds = ins.SecurityGroups?.map(sg => sg.GroupId) || []

    for (const groupId of sgIds) {
      try {
        await this.client.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: groupId,
          IpPermissions: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }], Ipv6Ranges: [{ CidrIpv6: '::/0' }] }]
        }))
      } catch (err) {
        if (!err.message.includes('already exists') && err.name !== 'InvalidPermission.Duplicate') {
          throw err
        }
      }
    }
    return { success: true }
  }

  static normalizeInstance(raw, region) {
    const publicIps = new Set()
    const privateIps = new Set()
    const ipv6Addresses = new Set()

    if (raw.PublicIpAddress) publicIps.add(raw.PublicIpAddress)
    if (raw.PrivateIpAddress) privateIps.add(raw.PrivateIpAddress)

    for (const item of raw.NetworkInterfaces || []) {
      if (item.Association?.PublicIp) publicIps.add(item.Association.PublicIp)
      if (item.PrivateIpAddress) privateIps.add(item.PrivateIpAddress)
      for (const privateIp of item.PrivateIpAddresses || []) {
        if (privateIp.PrivateIpAddress) privateIps.add(privateIp.PrivateIpAddress)
        if (privateIp.Association?.PublicIp) publicIps.add(privateIp.Association.PublicIp)
      }
      for (const ipv6 of item.Ipv6Addresses || []) {
        if (ipv6.Ipv6Address) ipv6Addresses.add(ipv6.Ipv6Address)
      }
    }

    return {
      id: raw.InstanceId,
      displayName: raw.Tags?.find(t => t.Key === 'Name')?.Value || raw.InstanceId,
      state: raw.State?.Name?.toUpperCase() || 'UNKNOWN',
      publicIps: Array.from(publicIps),
      privateIps: Array.from(privateIps),
      ipv6Addresses: Array.from(ipv6Addresses),
      region,
      zone: raw.Placement?.AvailabilityZone || region,
      shape: raw.InstanceType,
      cpu: null,
      memoryGb: null,
      provider: 'aws',
      timeCreated: raw.LaunchTime,
      tags: (raw.Tags || []).reduce((acc, t) => { acc[t.Key] = t.Value; return acc }, {}),
      raw
    }
  }
}
