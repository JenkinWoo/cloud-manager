/**
 * BaseComputeProvider - 所有计算 Provider 的抽象基类
 * 子类必须实现：listInstances, createInstance, deleteInstance, instanceAction
 * 子类可选实现：switchPublicIp, addIpv6
 */
export default class BaseComputeProvider {
  constructor(account) {
    this.account = account
    if (new.target === BaseComputeProvider) {
      throw new Error('BaseComputeProvider 是抽象类，不能直接实例化')
    }
  }

  /** @returns {Promise<Array<NormalizedInstance>>} */
  async listInstances() { throw new Error('listInstances() 未实现') }

  /** @param {object} params - { shape, ... } @returns {Promise<{instanceId, displayName}>} */
  async createInstance(params) { throw new Error('createInstance() 未实现') }

  /** @param {string} instanceId */
  async deleteInstance(instanceId) { throw new Error('deleteInstance() 未实现') }

  /**
   * @param {string} instanceId
   * @param {string} action - 'START' | 'STOP' | 'REBOOT' | 'HARD_REBOOT'
   */
  async instanceAction(instanceId, action) { throw new Error('instanceAction() 未实现') }

  /** 可选：切换 IP，options.ipTypes 可为 ['ipv4'] / ['ipv6'] / ['ipv4', 'ipv6'] */
  async switchPublicIp(instanceId, options = {}) { throw new Error('switchPublicIp() 未支持') }

  /** 可选：添加 IPv6，@returns {Promise<{ipAddress}>} */
  async addIpv6(instanceId) { throw new Error('addIpv6() 未支持') }

  /** 可选：修改引导卷大小 */
  async resizeBootVolume(bootVolumeId, sizeInGBs) { throw new Error('resizeBootVolume() 未支持') }

  /** 可选：获取实例详情 */
  async getInstance(instanceId) { throw new Error('getInstance() 未实现') }

  /** @returns {string[]} 当前 Provider 支持的功能 */
  get capabilities() { return this.constructor.capabilities || [] }

  static providerName = 'base'
  static capabilities = []

  /**
   * 标准化实例结构，所有 Provider 都应返回此格式
   * @param {object} raw - 原始实例对象
   * @returns {NormalizedInstance}
   */
  static normalizeInstance(raw) {
    // 子类覆盖此方法
    return raw
  }
}

/**
 * @typedef {Object} NormalizedInstance
 * @property {string} id
 * @property {string} displayName
 * @property {string} state - RUNNING | STOPPED | PROVISIONING | TERMINATED | REBOOTING | STARTING | STOPPING
 * @property {string[]} publicIps
 * @property {string[]} privateIps
 * @property {string[]} ipv6Addresses
 * @property {string} region
 * @property {string} zone
 * @property {string} shape
 * @property {number} cpu
 * @property {number} memoryGb
 * @property {string} provider
 * @property {string} timeCreated
 * @property {object} raw
 */
